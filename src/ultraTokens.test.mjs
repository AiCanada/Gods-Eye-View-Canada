import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  ULTRA_TOKEN_PREFIX,
  ULTRA_TOKEN_PATTERN,
  ULTRA_HELP_TEXT_LIMIT,
  ULTRA_HELP_NAME_LIMIT,
  ULTRA_HELP_BODY_LIMIT,
  ULTRA_TOKEN_COOLDOWN_MS,
  ULTRA_TOKEN_HOURLY_LIMIT,
  ULTRA_HOLDER_ADDRESS_LIMIT,
  ULTRA_HOLDER_MISS_LIMIT,
  ULTRA_INBOX_LIMIT,
  ULTRA_NOTIFY_LIMIT,
  ULTRA_TOKEN_LIMIT,
  newUltraToken,
  newUltraTokenKeyText,
  parseUltraTokenKey,
  ultraTokenHash,
  ultraTokenHashEqual,
  ultraTokenFingerprint,
  ultraTokenPolicyMac,
  ultraTokenPolicyState,
  stampUltraTokenPolicy,
  ultraTokenRecordVerdict,
  ultraTokenDisplayedSkills,
  selectUltraToken,
  ultraTokenRowTampered,
  ultraTokenStoreHasPolicyMac,
  ultraTokenTamperFlags,
  ultraTokenId,
  ultraMessageId,
  sealUltraToken,
  openUltraToken,
  findUltraToken,
  ULTRA_SKILL_SETS,
  ULTRA_CUSTOM_SKILL_LIMIT,
  composeUltraToken,
  readUltraTokenSkills,
  normalizeUltraSkillRequest,
  ultraTokenSkillFields,
  ultraSkillSlug,
  normalizeUltraTokenRecord,
  normalizeUltraTokenStore,
  normalizeUltraInboxRecord,
  normalizeUltraInbox,
  ultraInboxPolicyMac,
  ultraInboxPolicyState,
  ultraInboxVisibleMessages,
  cleanHelpText,
  cleanPosition,
  ultraHelpMessageRecord,
  ultraNotifyItem,
  allowUltraRequest,
  ultraTokenSendAllowed,
  ultraHelpSmsLink,
  ultraClientAddress,
} from './ultraTokens.mjs';

const NOW = Date.parse('2026-09-27T18:00:00Z');
const PHONE_KEY = /^[A-Za-z0-9_-]{43}$/;
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const fixedBytes = (fill) => (n) => Buffer.alloc(n, fill);
const TOKEN = newUltraToken(fixedBytes(0));
const ID = ultraTokenId(fixedBytes(0xab));

function record(overrides = {}) {
  const id = overrides.id || ID;
  const token = overrides.token || TOKEN;
  return {
    id,
    feedId: 'security-van',
    label: 'Neighbour',
    sms: true,
    voice: true,
    createdAt: NOW - 1000,
    revokedAt: null,
    hash: ultraTokenHash(token),
    sealed: sealUltraToken(token, KEY, { id, randomBytes: fixedBytes(3) }),
    ...overrides,
  };
}

function flip(base64, index = 0) {
  const bytes = Buffer.from(base64, 'base64');
  bytes[index] ^= 0xff;
  return bytes.toString('base64');
}

test('the limit constants are the numbers the routes quote', () => {
  assert.equal(ULTRA_TOKEN_PREFIX, 'uht1.');
  assert.equal(ULTRA_HELP_TEXT_LIMIT, 500);
  assert.equal(ULTRA_HELP_NAME_LIMIT, 60);
  assert.equal(ULTRA_HELP_BODY_LIMIT, 4096);
  assert.equal(ULTRA_TOKEN_COOLDOWN_MS, 10_000);
  assert.equal(ULTRA_TOKEN_HOURLY_LIMIT, 20);
  assert.deepEqual(ULTRA_HOLDER_ADDRESS_LIMIT, { max: 60, windowMs: 60_000 });
  assert.deepEqual(ULTRA_HOLDER_MISS_LIMIT, { max: 20, windowMs: 60_000 });
  assert.ok(Object.isFrozen(ULTRA_HOLDER_ADDRESS_LIMIT));
  assert.ok(Object.isFrozen(ULTRA_HOLDER_MISS_LIMIT));
  assert.equal(ULTRA_INBOX_LIMIT, 100);
  assert.equal(ULTRA_NOTIFY_LIMIT, 20);
  assert.equal(ULTRA_TOKEN_LIMIT, 200);
});

test('a token is uht1. plus 43 base64url characters and never a phone key', () => {
  assert.equal(TOKEN, 'uht1.' + 'A'.repeat(43));
  assert.equal(TOKEN.length, 48);
  assert.match(TOKEN, ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch(TOKEN, PHONE_KEY);
  assert.doesNotMatch(TOKEN.slice(5), ULTRA_TOKEN_PATTERN);
  assert.match(TOKEN.slice(5), PHONE_KEY);
  const real = newUltraToken();
  assert.match(real, ULTRA_TOKEN_PATTERN);
  assert.notEqual(real, newUltraToken());
  const body = real.slice(5);
  assert.equal(Buffer.from(body, 'base64url').length, 32);
  assert.doesNotMatch('uht2.' + 'A'.repeat(43), ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch(TOKEN + ' ', ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch(TOKEN + '\n', ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch('uht1.' + 'A'.repeat(42) + '=', ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch('uht1.' + 'A'.repeat(42), ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch('uht1.' + 'A'.repeat(44), ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch('uht1.' + 'A'.repeat(42) + '+', ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch('UHT1.' + 'A'.repeat(43), ULTRA_TOKEN_PATTERN);
});

test('hash, fingerprint and ids have their shapes and the hash is stable', () => {
  const hash = ultraTokenHash(TOKEN);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, ultraTokenHash(TOKEN));
  assert.equal(
    hash,
    crypto.createHash('sha256').update(TOKEN, 'utf8').digest('hex'),
  );
  assert.notEqual(hash, ultraTokenHash(TOKEN.slice(0, -1) + 'B'));
  assert.equal(ultraTokenFingerprint(hash), hash.slice(0, 8));
  assert.equal(ultraTokenFingerprint(hash).length, 8);
  assert.equal(ultraTokenFingerprint('short'), '');
  assert.equal(ultraTokenFingerprint(null), '');
  assert.equal(ID, 't-abababababababab');
  assert.match(ultraTokenId(), /^t-[0-9a-f]{16}$/);
  assert.notEqual(ultraTokenId(), ultraTokenId());
  assert.equal(ultraMessageId(fixedBytes(0xcd)), 'm-cdcdcdcdcdcdcdcd');
  assert.match(ultraMessageId(), /^m-[0-9a-f]{16}$/);
  // The id never comes from the token: the same token gets whatever bytes are drawn.
  assert.notEqual(ID.slice(2), hash.slice(0, 16));
});

test('the key file text is 64 hex plus a newline and parses back with whitespace tolerated', () => {
  const text = newUltraTokenKeyText(fixedBytes(0x5a));
  assert.equal(text, '5a'.repeat(32) + '\n');
  assert.deepEqual(parseUltraTokenKey(text), Buffer.alloc(32, 0x5a));
  assert.deepEqual(
    parseUltraTokenKey('  ' + '5a'.repeat(32) + ' \r\n'),
    Buffer.alloc(32, 0x5a),
  );
  assert.equal(parseUltraTokenKey('5a'.repeat(32).slice(1)), null);
  assert.equal(parseUltraTokenKey('5a'.repeat(32) + 'a'), null);
  assert.equal(parseUltraTokenKey('5g'.repeat(32)), null);
  assert.equal(parseUltraTokenKey(''), null);
  assert.equal(parseUltraTokenKey(null), null);
  assert.match(newUltraTokenKeyText(), /^[0-9a-f]{64}\n$/);
  assert.notEqual(newUltraTokenKeyText(), newUltraTokenKeyText());
});

test('seal and open round-trip under the key and the record id', () => {
  const sealed = sealUltraToken(TOKEN, KEY, {
    id: ID,
    randomBytes: fixedBytes(3),
  });
  assert.equal(sealed.v, 1);
  assert.deepEqual(Object.keys(sealed).sort(), ['data', 'iv', 'tag', 'v']);
  assert.equal(Buffer.from(sealed.iv, 'base64').length, 12);
  assert.equal(Buffer.from(sealed.tag, 'base64').length, 16);
  assert.equal(Buffer.from(sealed.data, 'base64').length, TOKEN.length);
  assert.ok(!JSON.stringify(sealed).includes(TOKEN));
  assert.equal(openUltraToken(sealed, KEY, { id: ID }), TOKEN);
  // A fresh iv each time: two seals of the same token differ.
  const again = sealUltraToken(TOKEN, KEY, { id: ID });
  assert.notEqual(again.iv, sealed.iv);
  assert.notEqual(again.data, sealed.data);
  assert.equal(openUltraToken(again, KEY, { id: ID }), TOKEN);
});

test('open returns null, never throws, for a wrong key, id, byte or shape', () => {
  const sealed = sealUltraToken(TOKEN, KEY, {
    id: ID,
    randomBytes: fixedBytes(3),
  });
  assert.equal(openUltraToken(sealed, OTHER_KEY, { id: ID }), null);
  assert.equal(openUltraToken(sealed, KEY, { id: 't-0000000000000000' }), null);
  assert.equal(openUltraToken(sealed, KEY, {}), null);
  assert.equal(
    openUltraToken({ ...sealed, data: flip(sealed.data, 5) }, KEY, { id: ID }),
    null,
  );
  assert.equal(
    openUltraToken({ ...sealed, tag: flip(sealed.tag, 0) }, KEY, { id: ID }),
    null,
  );
  assert.equal(
    openUltraToken({ ...sealed, iv: flip(sealed.iv, 1) }, KEY, { id: ID }),
    null,
  );
  assert.equal(openUltraToken({ ...sealed, v: 2 }, KEY, { id: ID }), null);
  assert.equal(openUltraToken({ ...sealed, v: '1' }, KEY, { id: ID }), null);
  const { tag, ...noTag } = sealed;
  assert.equal(openUltraToken(noTag, KEY, { id: ID }), null);
  const { iv, ...noIv } = sealed;
  assert.equal(openUltraToken(noIv, KEY, { id: ID }), null);
  const { data, ...noData } = sealed;
  assert.equal(openUltraToken(noData, KEY, { id: ID }), null);
  assert.equal(
    openUltraToken({ ...sealed, iv: 'not base64!' }, KEY, { id: ID }),
    null,
  );
  assert.equal(
    openUltraToken(
      { ...sealed, iv: Buffer.alloc(16).toString('base64') },
      KEY,
      { id: ID },
    ),
    null,
  );
  assert.equal(openUltraToken(null, KEY, { id: ID }), null);
  assert.equal(openUltraToken('text', KEY, { id: ID }), null);
  assert.equal(openUltraToken(sealed, Buffer.alloc(16), { id: ID }), null);
  assert.equal(openUltraToken(sealed, 'not a buffer', { id: ID }), null);
  assert.equal(openUltraToken(sealed, null, { id: ID }), null);
  // A blob that opens to something other than a token is refused too.
  const odd = sealUltraToken('hello', KEY, { id: ID });
  assert.equal(openUltraToken(odd, KEY, { id: ID }), null);
});

test('findUltraToken admits by hash in constant time and leaves revocation to the caller', () => {
  const other = newUltraToken(fixedBytes(0x42));
  const first = record({ id: 't-1111111111111111' });
  const second = record({ id: 't-2222222222222222', token: other });
  assert.equal(findUltraToken([first, second], TOKEN), first);
  assert.equal(findUltraToken([first, second], other), second);
  assert.equal(
    findUltraToken([first, second], newUltraToken(fixedBytes(0x43))),
    null,
  );
  assert.equal(findUltraToken([], TOKEN), null);
  assert.equal(findUltraToken(null, TOKEN), null);
  // Two records sharing a hash: every record is still compared, and the first match is kept.
  const twin = record({ id: 't-3333333333333333' });
  assert.equal(findUltraToken([first, second, twin], TOKEN), first);
  assert.equal(findUltraToken([twin, second, first], TOKEN), twin);
  // A revoked record is still returned; the route answers 404 for it.
  const revoked = record({ id: 't-4444444444444444', revokedAt: NOW });
  assert.equal(findUltraToken([second, revoked], TOKEN), revoked);
  // A record with a malformed hash is compared against zero and never matches.
  assert.equal(findUltraToken([{ ...first, hash: 'zz' }], TOKEN), null);
  assert.equal(findUltraToken([null, first], TOKEN), first);
});

test('findUltraToken refuses a bad shape before hashing anything', () => {
  const calls = [];
  const hash = (value) => {
    calls.push(value);
    return ultraTokenHash(value);
  };
  const list = [record()];
  for (const bad of [
    TOKEN.slice(5),
    'uht2.' + 'A'.repeat(43),
    TOKEN + '/',
    TOKEN + '\n',
    TOKEN + '.s.no',
    TOKEN + '.s.',
    'uht1.' + 'A'.repeat(42),
    '',
    null,
    undefined,
    42,
    { toString: () => TOKEN },
  ]) {
    assert.equal(findUltraToken(list, bad, { hash }), null);
  }
  assert.deepEqual(calls, []);
  assert.equal(findUltraToken(list, TOKEN, { hash }), list[0]);
  assert.deepEqual(calls, [TOKEN]);
});

test('the policy MAC covers the flags, and a repeated hash keeps every record', () => {
  const good = normalizeUltraTokenRecord(record());
  assert.equal(ultraTokenPolicyState(good, KEY), 'legacy');
  assert.equal(ultraTokenRecordVerdict(good, KEY), 'legacy');
  assert.equal(ultraTokenHashEqual(good.hash, TOKEN), true);
  assert.equal(ultraTokenHashEqual('zz', TOKEN), false);
  assert.equal(ultraTokenHashEqual(null, TOKEN), false);
  const stamped = stampUltraTokenPolicy(good, KEY);
  assert.deepEqual(stamped.skills, []);
  assert.match(stamped.policyMac, /^[0-9a-f]{64}$/);
  assert.equal(stamped.policyMac, ultraTokenPolicyMac(stamped, KEY));
  assert.equal(ultraTokenPolicyState(stamped, KEY), 'ok');
  assert.equal(ultraTokenRecordVerdict(stamped, KEY), 'ok');
  assert.equal(ultraTokenPolicyState({ ...stamped, sms: false }, KEY), 'bad');
  assert.equal(
    ultraTokenRecordVerdict({ ...stamped, sms: false }, KEY),
    'tampered',
  );
  assert.equal(
    ultraTokenPolicyState({ ...stamped, policyMac: 'bad' }, KEY),
    'bad',
  );
  assert.equal(
    ultraTokenPolicyState({ ...stamped, policyMac: '' }, KEY),
    'legacy',
  );
  assert.equal(ultraTokenPolicyState(stamped, OTHER_KEY), 'bad');
  assert.equal(ultraTokenRecordVerdict(stamped, OTHER_KEY), 'unsealed');
  assert.equal(ultraTokenRecordVerdict(stamped, null), 'unsealed');
  assert.equal(stampUltraTokenPolicy(good, null), good);
  // Without a length prefix these two canonical forms are the same string.
  const shifted = stampUltraTokenPolicy(
    { ...good, feedId: 'van\nNeighbour', label: 'ok' },
    KEY,
  );
  const plain = stampUltraTokenPolicy(
    { ...good, feedId: 'van', label: 'Neighbour\nok' },
    KEY,
  );
  assert.notEqual(shifted.policyMac, plain.policyMac);
  const marked = normalizeUltraTokenRecord({ ...good, policyMac: 'nope' });
  assert.equal(marked.policyMac, 'bad');
  assert.equal('policyMac' in normalizeUltraTokenRecord(good), false);
  const twin = record({ id: 't-3333333333333333' });
  const stored = normalizeUltraTokenStore({
    tokens: [good, twin, { ...twin, policyMac: 'nope' }],
  });
  // Same hash, different ids: both stay. The same id again keeps the first.
  assert.deepEqual(
    stored.tokens.map((item) => item.id),
    [good.id, 't-3333333333333333'],
  );
  assert.equal(stored.tokens[0].hash, stored.tokens[1].hash);
  const many = Array.from({ length: ULTRA_TOKEN_LIMIT + 1 }, (_, index) =>
    record({
      id: `t-${index.toString(16).padStart(16, '0')}`,
      token: newUltraToken(fixedBytes(index + 1)),
    }),
  );
  assert.equal(
    normalizeUltraTokenStore({ tokens: many }).tokens.length,
    ULTRA_TOKEN_LIMIT + 1,
  );
  const skilled = composeUltraToken(TOKEN, [{ code: 'dr', label: 'Doctor' }]);
  const clear = normalizeUltraTokenRecord({
    ...record({ token: skilled }),
    skills: [{ code: 'ff', label: 'Firefighter' }],
  });
  assert.deepEqual(
    ultraTokenDisplayedSkills(clear, KEY).skills.map((item) => item.label),
    ['Doctor'],
  );
  assert.equal(
    ultraTokenDisplayedSkills(clear, null).skills[0].label,
    'Firefighter',
  );
  const lied = { ...clear, hash: ultraTokenHash('uht1.' + 'B'.repeat(43)) };
  assert.deepEqual(ultraTokenDisplayedSkills(lied, KEY).skills, []);
  assert.equal(ultraTokenRecordVerdict(lied, KEY), 'tampered');
  const hiddenToken = composeUltraToken(
    newUltraToken(fixedBytes(5)),
    [{ code: 'dr', label: 'Doctor' }],
    { encrypt: true, key: KEY, randomBytes: fixedBytes(4) },
  );
  const hidden = normalizeUltraTokenRecord({
    ...record({ id: 't-5555555555555555', token: hiddenToken }),
    skills: [{ code: 'dr', label: 'Doctor' }],
    encrypted: true,
  });
  assert.deepEqual(
    ultraTokenDisplayedSkills(hidden, KEY).skills.map((item) => item.label),
    ['Doctor'],
  );
  assert.deepEqual(ultraTokenDisplayedSkills(hidden, null).skills, []);
  assert.equal(ultraTokenDisplayedSkills(hidden, null).encrypted, true);
});

test('admission prefers the seal that opens and does not trust a deleted check beside a real one', () => {
  const good = stampUltraTokenPolicy(normalizeUltraTokenRecord(record()), KEY);
  const otherToken = newUltraToken(fixedBytes(0x42));
  const other = stampUltraTokenPolicy(
    normalizeUltraTokenRecord(
      record({ id: 't-4444444444444444', token: otherToken }),
    ),
    KEY,
  );
  // A copy of the hash, under a new id, so the copied seal will not open.
  const evil = {
    ...good,
    id: 't-9999999999999999',
    anytime: true,
    sms: false,
  };
  delete evil.policyMac;
  const copied = [evil, good, other];
  const admitted = selectUltraToken(copied, TOKEN, KEY);
  assert.equal(admitted.tampered, false);
  assert.equal(admitted.record.id, good.id);
  assert.equal(ultraTokenRowTampered(evil, copied, KEY), true);
  assert.equal(ultraTokenRowTampered(good, copied, KEY), false);
  assert.deepEqual(ultraTokenTamperFlags(copied, KEY), [true, false, false]);
  // The first hash match is still what findUltraToken returns.
  assert.equal(findUltraToken(copied, TOKEN), evil);
  // No other seal opens: a replaced seal cannot be told from a replaced key.
  assert.equal(selectUltraToken([evil], TOKEN, KEY).tampered, false);
  assert.equal(selectUltraToken([evil], TOKEN, KEY).record.id, evil.id);
  // Another token's seal opens, so this broken one is refused.
  const broken = {
    ...good,
    sealed: { ...good.sealed, data: flip(good.sealed.data, 0) },
  };
  assert.equal(selectUltraToken([broken, other], TOKEN, KEY).tampered, true);
  assert.equal(ultraTokenRowTampered(broken, [broken, other], KEY), true);
  assert.equal(ultraTokenRowTampered(other, [broken, other], KEY), false);
  // The check was removed, and another token still has one.
  const stripped = { ...good, anytime: true };
  delete stripped.policyMac;
  const mixed = [stripped, other];
  assert.equal(ultraTokenStoreHasPolicyMac(mixed), true);
  assert.equal(selectUltraToken(mixed, TOKEN, KEY).tampered, true);
  assert.equal(ultraTokenRowTampered(stripped, mixed, KEY), true);
  assert.equal(ultraTokenStoreHasPolicyMac([stripped]), false);
  assert.equal(selectUltraToken([stripped], TOKEN, KEY).tampered, false);
  // A replaced key opens nothing, so neither row is tampered and the link admits.
  assert.equal(
    selectUltraToken([good, other], TOKEN, OTHER_KEY).tampered,
    false,
  );
  assert.equal(
    selectUltraToken([good, other], TOKEN, OTHER_KEY).record.id,
    good.id,
  );
  assert.deepEqual(ultraTokenTamperFlags([good, other], OTHER_KEY), [
    false,
    false,
  ]);
  assert.equal(selectUltraToken([good], TOKEN, null).tampered, false);
  assert.equal(selectUltraToken([evil, good], TOKEN, null).record.id, evil.id);
  // A revoked copy that still checks out does not hide a live one.
  const revokedLive = stampUltraTokenPolicy(
    normalizeUltraTokenRecord(
      record({ id: 't-5555555555555555', revokedAt: NOW }),
    ),
    KEY,
  );
  const picked = selectUltraToken([revokedLive, good], TOKEN, KEY);
  assert.equal(picked.tampered, false);
  assert.equal(picked.record.id, good.id);
  assert.equal(
    selectUltraToken([revokedLive], TOKEN, KEY).record.revokedAt,
    NOW,
  );
});

test('normalizeUltraTokenStore keeps only well-formed records and never caps the count', () => {
  const good = record();
  const out = normalizeUltraTokenStore({ version: 1, tokens: [good] });
  // A record from before the help network reads with network off, and from
  // before the directory ruling as not location only.
  assert.deepEqual(out, {
    version: 1,
    tokens: [
      {
        ...good,
        network: false,
        anytime: false,
        locationOnly: false,
        skills: [],
        encrypted: false,
      },
    ],
  });
  const dropped = [
    { ...good, id: 'token-1' },
    { ...good, id: 't-ABABABABABABABAB' },
    { ...good, id: 't-abababababababa' },
    { ...good, hash: good.hash.slice(1) },
    { ...good, hash: good.hash.toUpperCase() },
    { ...good, label: '' },
    { ...good, label: '   \u0000 ' },
    { ...good, label: null },
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
    null,
    'text',
    7,
  ];
  for (const item of dropped) {
    assert.equal(normalizeUltraTokenRecord(item), null, JSON.stringify(item));
  }
  assert.deepEqual(normalizeUltraTokenStore({ tokens: dropped }).tokens, []);
  // Coercion: flags become booleans, the label and feed id are cut, times are numbers or null.
  const loose = normalizeUltraTokenRecord({
    ...good,
    sms: 'yes',
    voice: 1,
    label: '  ' + 'x'.repeat(80) + '  ',
    feedId: 'f'.repeat(100),
    createdAt: '1700000000000',
    revokedAt: 'never',
    extra: 'ignored',
  });
  assert.equal(loose.sms, false);
  assert.equal(loose.voice, false);
  assert.equal(loose.label, 'x'.repeat(60));
  assert.equal(loose.feedId, 'f'.repeat(80));
  assert.equal(loose.createdAt, 1700000000000);
  assert.equal(loose.revokedAt, null);
  assert.equal('extra' in loose, false);
  assert.deepEqual(Object.keys(loose.sealed).sort(), [
    'data',
    'iv',
    'tag',
    'v',
  ]);
  assert.equal(
    normalizeUltraTokenRecord({ ...good, sms: true, voice: false }).voice,
    false,
  );
  assert.equal(
    normalizeUltraTokenRecord({ ...good, sms: false, voice: true }).sms,
    false,
  );
  // Non-object input and a duplicate id.
  assert.deepEqual(normalizeUltraTokenStore(null), { version: 1, tokens: [] });
  assert.deepEqual(normalizeUltraTokenStore('x'), { version: 1, tokens: [] });
  assert.deepEqual(normalizeUltraTokenStore({ tokens: 'x' }), {
    version: 1,
    tokens: [],
  });
  assert.equal(
    normalizeUltraTokenStore({ tokens: [good, { ...good }] }).tokens.length,
    1,
  );
  // Reading does not cap the count. A repeated id keeps the first. A repeated hash is kept.
  const many = Array.from({ length: 300 }, (_, i) =>
    record({
      id: 't-' + i.toString(16).padStart(16, '0'),
      hash: i.toString(16).padStart(64, '0'),
    }),
  );
  assert.equal(normalizeUltraTokenStore({ tokens: many }).tokens.length, 300);
});

test('cleanHelpText strips control characters, collapses runs and cuts at the limit', () => {
  assert.equal(
    cleanHelpText('Smoke\u0000 at\u0007 the\u001f back\u007f door'),
    'Smoke at the back door',
  );
  // A message keeps its lines; a name, label or place (the default) is one line.
  assert.equal(
    cleanHelpText('line one\nline two', 500, { lines: true }),
    'line one\nline two',
  );
  assert.equal(cleanHelpText('a\r\nb', 500, { lines: true }), 'a\nb');
  assert.equal(cleanHelpText('line one\nline two'), 'line one line two');
  assert.equal(cleanHelpText('JEFF\n\nFAKE ALERT'), 'JEFF FAKE ALERT');
  assert.equal(cleanHelpText('a\r\nb'), 'a b');
  assert.equal(cleanHelpText('  a   b\t\tc \t d  '), 'a b c d');
  assert.equal(cleanHelpText('a\tb'), 'a b');
  assert.equal(cleanHelpText('   '), '');
  assert.equal(cleanHelpText('\t\n\t'), '');
  assert.equal(cleanHelpText(''), '');
  assert.equal(cleanHelpText(null), '');
  assert.equal(cleanHelpText(undefined), '');
  assert.equal(cleanHelpText(12), '12');
  assert.equal(cleanHelpText('x'.repeat(600)).length, 500);
  assert.equal(cleanHelpText('x'.repeat(600), 60).length, 60);
  assert.equal(cleanHelpText('<b>x</b>'), '<b>x</b>');
  assert.equal(cleanHelpText('é ñ 中'), 'é ñ 中');
});

test('ultraHelpMessageRecord keeps only checked claims and drops an empty text', () => {
  const rec = record();
  const ids = { message: () => 'm-0123456789abcdef' };
  const message = ultraHelpMessageRecord({
    record: rec,
    body: {
      text: 'Smoke\u0000 at the back door',
      from: 'Sam',
      number: '+1 (506) 555-0100',
      lat: 45.27,
      lon: -66.06,
      extra: 'ignored',
    },
    now: NOW,
    ids,
  });
  assert.deepEqual(message, {
    id: 'm-0123456789abcdef',
    tokenId: ID,
    kind: 'message',
    networkId: '',
    label: 'Neighbour',
    from: 'Sam',
    number: '+15065550100',
    text: 'Smoke at the back door',
    place: '',
    incident: '',
    lat: 45.27,
    lon: -66.06,
    at: NOW,
    until: null,
    sms: '',
    deliveredAt: null,
    readAt: null,
  });
  assert.equal(
    ultraHelpMessageRecord({
      record: rec,
      body: { text: '  \u0001 ' },
      now: NOW,
      ids,
    }),
    null,
  );
  assert.equal(
    ultraHelpMessageRecord({ record: rec, body: {}, now: NOW, ids }),
    null,
  );
  assert.equal(
    ultraHelpMessageRecord({ record: rec, body: null, now: NOW, ids }),
    null,
  );
  const make = (body) =>
    ultraHelpMessageRecord({
      record: rec,
      body: { text: 'help', ...body },
      now: NOW,
      ids,
    });
  assert.equal(make({ number: '5065550100' }).number, '');
  assert.equal(make({ number: 'call me' }).number, '');
  assert.equal(make({}).number, '');
  assert.equal(make({ from: 'x'.repeat(80) }).from, 'x'.repeat(60));
  assert.equal(make({ from: '\u0000' }).from, '');
  assert.equal(make({ text: 'x'.repeat(600) }).text.length, 500);
  assert.deepEqual(
    [make({ lat: 0, lon: 0 }).lat, make({ lat: 0, lon: 0 }).lon],
    [null, null],
  );
  assert.deepEqual(
    [make({ lat: 91, lon: 10 }).lat, make({ lat: 91, lon: 10 }).lon],
    [null, null],
  );
  assert.deepEqual(
    [make({ lat: 10, lon: -181 }).lat, make({ lat: 10, lon: -181 }).lon],
    [null, null],
  );
  assert.deepEqual(
    [make({ lat: 45 }).lat, make({ lat: 45 }).lon],
    [null, null],
  );
  assert.deepEqual(
    [make({ lat: 'north', lon: 1 }).lat, make({ lat: 'north', lon: 1 }).lon],
    [null, null],
  );
  assert.deepEqual(
    [
      make({ lat: '45.5', lon: '-66' }).lat,
      make({ lat: '45.5', lon: '-66' }).lon,
    ],
    [45.5, -66],
  );
  assert.deepEqual(
    [make({ lat: 0, lon: 1 }).lat, make({ lat: 0, lon: 1 }).lon],
    [0, 1],
  );
  // The id maker may be a function or injected bytes.
  assert.equal(
    ultraHelpMessageRecord({
      record: rec,
      body: { text: 'a' },
      now: NOW,
      ids: () => 'm-ffffffffffffffff',
    }).id,
    'm-ffffffffffffffff',
  );
  assert.equal(
    ultraHelpMessageRecord({
      record: rec,
      body: { text: 'a' },
      now: NOW,
      ids: { randomBytes: fixedBytes(0xee) },
    }).id,
    'm-eeeeeeeeeeeeeeee',
  );
  assert.match(
    ultraHelpMessageRecord({ record: rec, body: { text: 'a' }, now: NOW }).id,
    /^m-[0-9a-f]{16}$/,
  );
});

test('ultraNotifyItem carries the message and nothing about the token', () => {
  const message = ultraHelpMessageRecord({
    record: record(),
    body: { text: 'help', from: 'Sam', number: '+15065550100', lat: 1, lon: 2 },
    now: NOW,
    ids: { message: () => 'm-0123456789abcdef' },
  });
  assert.deepEqual(ultraNotifyItem(message), {
    kind: 'notify',
    id: 'm-0123456789abcdef',
    label: 'Neighbour',
    from: 'Sam',
    number: '+15065550100',
    lat: 1,
    lon: 2,
    text: 'help',
    at: NOW,
  });
  assert.equal('tokenId' in ultraNotifyItem(message), false);
});

test('normalizeUltraInbox drops records without id, text or time and keeps the newest 100', () => {
  const good = {
    id: 'm-0123456789abcdef',
    tokenId: ID,
    kind: 'message',
    networkId: '',
    label: 'Neighbour',
    from: 'Sam',
    number: '+15065550100',
    text: 'help',
    place: '',
    incident: '',
    lat: 45.27,
    lon: -66.06,
    at: NOW,
    until: null,
    sms: '',
    deliveredAt: NOW + 1,
    readAt: null,
  };
  assert.deepEqual(normalizeUltraInboxRecord(good), good);
  for (const bad of [
    { ...good, id: 'x' },
    { ...good, id: 't-0123456789abcdef' },
    { ...good, text: '' },
    { ...good, text: '\u0000' },
    { ...good, at: null },
    { ...good, at: 'soon' },
    null,
    'text',
  ]) {
    assert.equal(normalizeUltraInboxRecord(bad), null, JSON.stringify(bad));
  }
  const loose = normalizeUltraInboxRecord({
    ...good,
    tokenId: 'gone',
    label: 'x'.repeat(70),
    from: 7,
    number: '5065550100',
    lat: 0,
    lon: 0,
    at: String(NOW),
    deliveredAt: 'x',
    readAt: undefined,
    extra: true,
  });
  assert.equal(loose.tokenId, '');
  assert.equal(loose.label, 'x'.repeat(60));
  assert.equal(loose.from, '7');
  assert.equal(loose.number, '');
  assert.equal(loose.lat, null);
  assert.equal(loose.lon, null);
  assert.equal(loose.at, NOW);
  assert.equal(loose.deliveredAt, null);
  assert.equal(loose.readAt, null);
  assert.equal('extra' in loose, false);
  assert.deepEqual(normalizeUltraInbox(null), { version: 1, messages: [] });
  assert.deepEqual(normalizeUltraInbox({ messages: 'x' }), {
    version: 1,
    messages: [],
  });
  const many = Array.from({ length: 150 }, (_, i) => ({
    ...good,
    id: 'm-' + i.toString(16).padStart(16, '0'),
    at: NOW + i,
  }));
  const out = normalizeUltraInbox({
    messages: many.reverse().concat([{ ...good }, { ...good }, null]),
  });
  assert.equal(out.version, 1);
  assert.equal(out.messages.length, 100);
  assert.equal(out.messages[0].at, NOW + 149);
  assert.equal(out.messages[99].at, NOW + 50);
  for (let i = 1; i < out.messages.length; i += 1) {
    assert.ok(out.messages[i - 1].at >= out.messages[i].at);
  }
  // Duplicate ids keep the first copy; a shuffled file comes back newest first.
  const shuffled = normalizeUltraInbox({
    messages: [
      { ...good, at: NOW - 5 },
      { ...good, id: 'm-ffffffffffffffff', at: NOW },
    ],
  });
  assert.deepEqual(
    shuffled.messages.map((m) => m.id),
    ['m-ffffffffffffffff', 'm-0123456789abcdef'],
  );
});

test('allowUltraRequest budgets each key in a sliding window and caps the map', () => {
  const buckets = new Map();
  const limit = { max: 3, windowMs: 60_000 };
  assert.equal(allowUltraRequest(buckets, 'a', NOW, limit), true);
  assert.equal(allowUltraRequest(buckets, 'a', NOW + 1000, limit), true);
  assert.equal(allowUltraRequest(buckets, 'a', NOW + 2000, limit), true);
  assert.equal(allowUltraRequest(buckets, 'a', NOW + 3000, limit), false);
  assert.equal(allowUltraRequest(buckets, 'a', NOW + 59_000, limit), false);
  // Another key has its own budget.
  assert.equal(allowUltraRequest(buckets, 'b', NOW + 3000, limit), true);
  // The first hit falls out of the window after windowMs and one more is allowed.
  assert.equal(allowUltraRequest(buckets, 'a', NOW + 60_001, limit), true);
  assert.equal(allowUltraRequest(buckets, 'a', NOW + 60_002, limit), false);
  // A full window later everything is forgotten.
  assert.equal(allowUltraRequest(buckets, 'a', NOW + 200_000, limit), true);
  assert.deepEqual(buckets.get('a'), [NOW + 200_000]);
  // The real budgets, as the routes use them.
  const addresses = new Map();
  for (let i = 0; i < ULTRA_HOLDER_ADDRESS_LIMIT.max; i += 1) {
    assert.equal(
      allowUltraRequest(
        addresses,
        '10.0.0.1',
        NOW + i,
        ULTRA_HOLDER_ADDRESS_LIMIT,
      ),
      true,
    );
  }
  assert.equal(
    allowUltraRequest(
      addresses,
      '10.0.0.1',
      NOW + 100,
      ULTRA_HOLDER_ADDRESS_LIMIT,
    ),
    false,
  );
  assert.equal(
    allowUltraRequest(
      addresses,
      '10.0.0.2',
      NOW + 100,
      ULTRA_HOLDER_ADDRESS_LIMIT,
    ),
    true,
  );
  const misses = new Map();
  for (let i = 0; i < ULTRA_HOLDER_MISS_LIMIT.max; i += 1) {
    assert.equal(
      allowUltraRequest(misses, '10.0.0.1', NOW + i, ULTRA_HOLDER_MISS_LIMIT),
      true,
    );
  }
  assert.equal(
    allowUltraRequest(misses, '10.0.0.1', NOW + 100, ULTRA_HOLDER_MISS_LIMIT),
    false,
  );
  // The map never grows past the cap; the least recently touched key goes first.
  const crowd = new Map();
  for (let i = 0; i < 1200; i += 1) {
    allowUltraRequest(crowd, 'k' + i, NOW + i, limit);
    assert.ok(crowd.size <= 1000);
  }
  assert.equal(crowd.size, 1000);
  assert.equal(crowd.has('k0'), false);
  assert.equal(crowd.has('k199'), false);
  assert.equal(crowd.has('k200'), true);
  assert.equal(crowd.has('k1199'), true);
  // Touching an old key keeps it alive past a newcomer.
  allowUltraRequest(crowd, 'k200', NOW + 2000, limit);
  allowUltraRequest(crowd, 'new', NOW + 2001, limit);
  assert.equal(crowd.has('k200'), true);
  assert.equal(crowd.has('k201'), false);
  const small = new Map();
  for (let i = 0; i < 5; i += 1)
    allowUltraRequest(small, 'k' + i, NOW + i, { ...limit, cap: 2 });
  assert.deepEqual([...small.keys()], ['k3', 'k4']);
});

test('ultraTokenSendAllowed enforces the cooldown and the hourly cap on accepted sends', () => {
  const sends = [];
  assert.deepEqual(ultraTokenSendAllowed(sends, NOW), {
    ok: true,
    reason: '',
    sent: 0,
  });
  // Nothing is recorded by asking; the caller pushes on acceptance.
  assert.deepEqual(sends, []);
  sends.push(NOW);
  assert.deepEqual(ultraTokenSendAllowed(sends, NOW + 5000), {
    ok: false,
    reason: 'cooldown',
    sent: 1,
  });
  assert.deepEqual(ultraTokenSendAllowed(sends, NOW + 9999), {
    ok: false,
    reason: 'cooldown',
    sent: 1,
  });
  assert.deepEqual(ultraTokenSendAllowed(sends, NOW + 10_000), {
    ok: true,
    reason: '',
    sent: 1,
  });
  // Twenty accepted sends in the hour, spaced out, then the cap.
  const busy = [];
  for (let i = 0; i < ULTRA_TOKEN_HOURLY_LIMIT; i += 1) {
    const at = NOW + i * 60_000;
    assert.equal(ultraTokenSendAllowed(busy, at).ok, true, `send ${i}`);
    busy.push(at);
  }
  const capped = ultraTokenSendAllowed(busy, NOW + 21 * 60_000);
  assert.deepEqual(capped, { ok: false, reason: 'hourly', sent: 20 });
  // The cap names itself even inside the cooldown, since it lasts longer.
  assert.equal(
    ultraTokenSendAllowed(busy, NOW + 19 * 60_000 + 5000).reason,
    'hourly',
  );
  // An hour after the first send it falls out of the window and one more is allowed.
  const later = ultraTokenSendAllowed(busy, NOW + 60 * 60_000 + 1);
  assert.deepEqual(later, { ok: true, reason: '', sent: 19 });
  assert.equal(busy.length, 19);
  assert.equal(busy.includes(NOW), false);
  // Pruning is in place and drops everything older than the window.
  const stale = [NOW - 2 * 60 * 60_000, NOW - 60 * 60_000 - 1, NOW - 1000];
  assert.deepEqual(ultraTokenSendAllowed(stale, NOW), {
    ok: false,
    reason: 'cooldown',
    sent: 1,
  });
  assert.deepEqual(stale, [NOW - 1000]);
  // Options override the defaults.
  assert.deepEqual(
    ultraTokenSendAllowed([NOW - 500], NOW, { cooldownMs: 100 }),
    { ok: true, reason: '', sent: 1 },
  );
  assert.deepEqual(
    ultraTokenSendAllowed([NOW - 50_000], NOW, { hourlyLimit: 1 }),
    { ok: false, reason: 'hourly', sent: 1 },
  );
});

test('ultraHelpSmsLink builds sms: only from an E.164 or empty number', () => {
  assert.equal(
    ultraHelpSmsLink('+15065550100', 'Re your help message: '),
    'sms:+15065550100?body=Re%20your%20help%20message%3A%20',
  );
  assert.equal(
    ultraHelpSmsLink('+1 (506) 555-0100', 'hi'),
    'sms:+15065550100?body=hi',
  );
  assert.equal(
    ultraHelpSmsLink('', 'Help via Neighbour: smoke & fire'),
    'sms:?body=Help%20via%20Neighbour%3A%20smoke%20%26%20fire',
  );
  assert.equal(ultraHelpSmsLink(null, 'x'), 'sms:?body=x');
  assert.equal(ultraHelpSmsLink(undefined), 'sms:?body=');
  assert.equal(ultraHelpSmsLink('+15065550100'), 'sms:+15065550100?body=');
  assert.equal(ultraHelpSmsLink('5065550100', 'x'), '');
  assert.equal(ultraHelpSmsLink('911', 'x'), '');
  assert.equal(ultraHelpSmsLink('+0123', 'x'), '');
  assert.equal(ultraHelpSmsLink('+15065550100?body=evil', 'x'), '');
  assert.equal(ultraHelpSmsLink('javascript:alert(1)', 'x'), '');
  // The body never breaks out of the query: everything is percent-encoded.
  assert.equal(
    ultraHelpSmsLink('', '<script>\n"\'#?&'),
    "sms:?body=%3Cscript%3E%0A%22'%23%3F%26",
  );
});

test('ultraClientAddress trusts the forwarded hop only behind a loopback socket', () => {
  for (const loopback of [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '127.0.0.53',
  ]) {
    assert.equal(
      ultraClientAddress({
        remoteAddress: loopback,
        forwardedFor: '100.64.0.9',
      }),
      '100.64.0.9',
      loopback,
    );
    assert.equal(
      ultraClientAddress({
        remoteAddress: loopback,
        forwardedFor: '100.64.0.9, 10.0.0.1',
      }),
      '100.64.0.9',
      loopback,
    );
    assert.equal(
      ultraClientAddress({
        remoteAddress: loopback,
        forwardedFor: ' 100.64.0.9 ,10.0.0.1',
      }),
      '100.64.0.9',
      loopback,
    );
  }
  assert.equal(
    ultraClientAddress({ remoteAddress: '127.0.0.1', forwardedFor: '' }),
    '127.0.0.1',
  );
  assert.equal(
    ultraClientAddress({ remoteAddress: '::ffff:127.0.0.1' }),
    '127.0.0.1',
  );
  assert.equal(ultraClientAddress({ remoteAddress: '::1' }), '::1');
  // A LAN socket ignores the header entirely.
  assert.equal(
    ultraClientAddress({
      remoteAddress: '192.168.1.2',
      forwardedFor: '100.64.0.9',
    }),
    '192.168.1.2',
  );
  assert.equal(
    ultraClientAddress({
      remoteAddress: '::ffff:192.168.1.2',
      forwardedFor: '100.64.0.9',
    }),
    '192.168.1.2',
  );
  assert.equal(
    ultraClientAddress({
      remoteAddress: '1270.0.0.1',
      forwardedFor: '100.64.0.9',
    }),
    '1270.0.0.1',
  );
  assert.equal(
    ultraClientAddress({
      remoteAddress: 'fe80::1',
      forwardedFor: '100.64.0.9',
    }),
    'fe80::1',
  );
  assert.equal(ultraClientAddress({}), '');
  assert.equal(ultraClientAddress(), '');
  // The bucket key is bounded so a long header cannot bloat the map.
  assert.equal(
    ultraClientAddress({
      remoteAddress: '127.0.0.1',
      forwardedFor: 'x'.repeat(500),
    }).length,
    64,
  );
});

test('the module loads where Buffer and node:crypto are only stubs (the browser bundle)', () => {
  // The dashboard box takes ultraHelpSmsLink from ultraHelp.mjs, so no
  // browser bundle carries this module today; if one ever does, importing it
  // must still touch neither Buffer nor crypto until a server-side function
  // is called. A child process with the Buffer global removed stands in for
  // the browser.
  const moduleUrl = new URL('./ultraTokens.mjs', import.meta.url).href;
  const script = [
    'delete globalThis.Buffer;',
    `const m = await import(${JSON.stringify(moduleUrl)});`,
    "process.stdout.write(m.ultraHelpSmsLink('+15065550100', 'Re: '));",
  ].join('\n');
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(out, 'sms:+15065550100?body=Re%3A%20');
});

test('every token is 256 random bits, and a hundred thousand of them are all different', () => {
  // Uniqueness is arithmetic, not bookkeeping: 256 bits means the chance any
  // two of 10^12 tokens collide is about 2^-177. This checks the two things
  // that arithmetic rests on — the width of the draw, and that real draws do
  // not repeat — rather than the bound itself, which no test can reach.
  assert.equal(Buffer.from(newUltraToken().slice(5), 'base64url').length, 32);
  const seen = new Set();
  const runs = 100_000;
  for (let i = 0; i < runs; i += 1) {
    const token = newUltraToken();
    assert.match(token, ULTRA_TOKEN_PATTERN);
    seen.add(token);
  }
  assert.equal(seen.size, runs, 'no repeat in a hundred thousand draws');
});

test('a system generator returning a run of one byte mints nothing', () => {
  // The only realistic way to get a repeated token is a broken CSPRNG, so a
  // degenerate draw is refused instead of handed out as a secret. An
  // injected generator (every other test here) is left alone on purpose.
  const real = crypto.randomBytes;
  try {
    crypto.randomBytes = (n) => Buffer.alloc(n, 0);
    assert.throws(() => newUltraToken(), /not returning usable bytes/);
    assert.throws(() => newUltraTokenKeyText(), /not returning usable bytes/);
    crypto.randomBytes = (n) => Buffer.alloc(n, 0xff);
    assert.throws(() => newUltraToken(), /not returning usable bytes/);
    // A generator that is merely unlucky once still works.
    let call = 0;
    crypto.randomBytes = (n) =>
      (call += 1) === 1 ? Buffer.alloc(n, 0) : real(n);
    assert.match(newUltraToken(), ULTRA_TOKEN_PATTERN);
  } finally {
    crypto.randomBytes = real;
  }
  // The injected path is untouched: these bytes are deliberate.
  assert.equal(newUltraToken(fixedBytes(0)), 'uht1.' + 'A'.repeat(43));
});

test('cleanHelpText keeps only real text: zero-width characters go and non-strings are empty', () => {
  const zeroWidth = String.fromCharCode(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);
  assert.equal(cleanHelpText(zeroWidth + ' ' + zeroWidth), '');
  assert.equal(cleanHelpText('help' + zeroWidth + ' me'), 'help me');
  assert.equal(cleanHelpText({ a: 1 }), '');
  assert.equal(cleanHelpText(['x']), '');
  assert.equal(cleanHelpText(42), '42');
  assert.equal(cleanHelpText(null), '');
});

test('cleanHelpText drops what reorders or hides text: bidi controls, C1 controls, line separators', () => {
  // A right-to-left override in a peer's name would show the street after it reversed.
  const bidi = [
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
    0x2067, 0x2068, 0x2069,
  ].map((code) => String.fromCharCode(code));
  for (const mark of bidi) {
    assert.equal(
      cleanHelpText(`Sam${mark} at 10 Example St`),
      'Sam at 10 Example St',
      mark.charCodeAt(0).toString(16),
    );
  }
  assert.equal(cleanHelpText('Sam\u0085\u009b31m at home'), 'Sam31m at home');
  assert.equal(cleanHelpText('one two three'), 'onetwothree');
  assert.equal(
    cleanHelpText('one two', 500, { lines: true }),
    'onetwo',
    'a separator is not a line break, even in a message',
  );
  // Real text in other scripts is kept.
  assert.equal(cleanHelpText('سارا · שרה · Сара'), 'سارا · שרה · Сара');
});

test('the aad option binds a blob to its store: a home-list seal never opens as an owner token', () => {
  const sealed = sealUltraToken(TOKEN, KEY, {
    id: ID,
    randomBytes: fixedBytes(3),
    aad: 'ultra-network:',
  });
  assert.equal(
    openUltraToken(sealed, KEY, { id: ID, aad: 'ultra-network:' }),
    TOKEN,
  );
  assert.equal(openUltraToken(sealed, KEY, { id: ID }), null);
  assert.equal(
    openUltraToken(sealed, KEY, { id: ID, aad: 'ultra-token:' }),
    null,
  );
  assert.equal(
    openUltraToken(sealed, KEY, {
      id: 't-0000000000000000',
      aad: 'ultra-network:',
    }),
    null,
  );
  assert.equal(
    openUltraToken(sealed, OTHER_KEY, { id: ID, aad: 'ultra-network:' }),
    null,
  );
  // The default prefix is 'ultra-token:' and naming it changes nothing, so every existing record still opens.
  const plain = sealUltraToken(TOKEN, KEY, {
    id: ID,
    randomBytes: fixedBytes(3),
  });
  const named = sealUltraToken(TOKEN, KEY, {
    id: ID,
    randomBytes: fixedBytes(3),
    aad: 'ultra-token:',
  });
  assert.deepEqual(named, plain);
  assert.equal(
    openUltraToken(plain, KEY, { id: ID, aad: 'ultra-token:' }),
    TOKEN,
  );
  assert.equal(openUltraToken(named, KEY, { id: ID }), TOKEN);
  assert.equal(
    openUltraToken(plain, KEY, { id: ID, aad: 'ultra-network:' }),
    null,
  );
  // Same iv, same key, same token: only the AAD differs, so only the tag does.
  assert.equal(sealed.iv, plain.iv);
  assert.equal(sealed.data, plain.data);
  assert.notEqual(sealed.tag, plain.tag);
});

test('network on a token record is true only for a literal true', () => {
  const good = record();
  assert.equal('network' in good, false);
  assert.equal(normalizeUltraTokenRecord(good).network, false);
  assert.equal(
    normalizeUltraTokenRecord({ ...good, network: true }).network,
    true,
  );
  for (const value of [false, 'true', 1, 'on', null, undefined, {}, [true]]) {
    assert.equal(
      normalizeUltraTokenRecord({ ...good, network: value }).network,
      false,
      JSON.stringify(value),
    );
  }
  assert.equal(
    normalizeUltraTokenStore({
      tokens: [{ ...good, network: true }, good],
    }).tokens.map((t) => t.network)[0],
    true,
  );
  assert.deepEqual(Object.keys(normalizeUltraTokenRecord(good)), [
    'id',
    'feedId',
    'label',
    'sms',
    'voice',
    'network',
    'anytime',
    'locationOnly',
    'skills',
    'encrypted',
    'createdAt',
    'revokedAt',
    'hash',
    'sealed',
  ]);
  // Location only is a literal true; anything older or malformed reads off.
  assert.equal(normalizeUltraTokenRecord(good).locationOnly, false);
  assert.equal(
    normalizeUltraTokenRecord({ ...good, locationOnly: true }).locationOnly,
    true,
  );
  assert.equal(
    normalizeUltraTokenRecord({ ...good, locationOnly: 'yes' }).locationOnly,
    false,
  );
});

test('skill sets are written into the token string, in the clear or sealed', () => {
  assert.equal(ULTRA_SKILL_SETS.length, 13);
  assert.equal(ULTRA_CUSTOM_SKILL_LIMIT, 5);
  assert.equal(ULTRA_SKILL_SETS[0].label, 'Doctor');
  assert.equal(
    ULTRA_SKILL_SETS.find((item) => item.code === 'sr').label,
    'Search and Rescue (SAR) Specialist',
  );
  assert.equal(ultraSkillSlug('  Coast   Guard!! '), 'coast-guard');
  assert.equal(ultraSkillSlug('!!!'), '');
  assert.equal(ultraSkillSlug('a'.repeat(40)).length, 24);
  assert.equal(
    ultraSkillSlug('Search and Rescue Specialist Extra'),
    'search-and-rescue',
  );
  assert.equal(
    ultraSkillSlug('Hazardous Materials Team Extra'),
    'hazardous-materials-team',
  );

  const none = normalizeUltraSkillRequest({});
  assert.equal(none.ok, true);
  assert.equal(none.encrypt, false);
  assert.deepEqual(none.skills, []);
  assert.equal(composeUltraToken(TOKEN, none.skills), TOKEN);

  const asked = normalizeUltraSkillRequest({
    skills: ['rg', 'dr', 'dr', 'nope'],
  });
  assert.equal(asked.ok, false);
  assert.equal(asked.error, 'Unknown skill set');
  const mixed = normalizeUltraSkillRequest({
    skills: ['rg', 'dr', 'pm'],
    custom: ['  ', 'Coast Guard', 'Coast Guard', 'Swift Water'],
    encrypt: 'yes',
  });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.encrypt, false, 'only a literal true encrypts');
  assert.deepEqual(
    mixed.skills.map((item) => item.code),
    ['dr', 'pm', 'rg', 'xcoast-guard', 'xswift-water'],
  );
  assert.equal(mixed.skills[3].label, 'Coast Guard');
  assert.equal(
    normalizeUltraSkillRequest({ custom: ['  coast   guard!! '] }).skills[0]
      .label,
    'Coast Guard',
  );
  const shortened = normalizeUltraSkillRequest({
    custom: ['Search and Rescue Specialist Extra'],
  });
  assert.equal(shortened.skills[0].code, 'xsearch-and-rescue');
  assert.equal(shortened.skills[0].label, 'Search and Rescue');
  const clash = normalizeUltraSkillRequest({
    custom: [
      'Search and Rescue Specialist Alpha',
      'Search and Rescue Specialist Beta',
    ],
  });
  assert.equal(clash.ok, false);
  assert.equal(clash.error, 'Two custom skill sets would share one token code');
  assert.equal(
    composeUltraToken(TOKEN, [{ code: 'rg' }, { code: 'dr' }]),
    `${TOKEN}.s.dr.rg`,
  );
  assert.equal(
    composeUltraToken(TOKEN, [{ code: 'dr' }, { code: 'no' }]),
    null,
  );
  const tooMany = normalizeUltraSkillRequest({
    custom: ['a', 'b', 'c', 'd', 'e', 'f'],
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error, 'At most 5 custom skill sets');
  assert.equal(
    normalizeUltraSkillRequest({ custom: ['!!!'] }).error,
    'A custom skill set needs letters or numbers',
  );

  const clear = composeUltraToken(TOKEN, mixed.skills);
  assert.equal(clear, `${TOKEN}.s.dr.pm.rg.xcoast-guard.xswift-water`);
  assert.match(clear, ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch(clear, PHONE_KEY);
  assert.ok(!clear.includes('Doctor'));
  assert.deepEqual(
    readUltraTokenSkills(clear).skills.map((item) => item.label),
    ['Doctor', 'Paramedic', 'Ranger', 'Coast Guard', 'Swift Water'],
  );
  assert.deepEqual(ultraTokenSkillFields(clear), {
    skills: ['Doctor', 'Paramedic', 'Ranger', 'Coast Guard', 'Swift Water'],
  });
  // The hash covers the skills, so the bare secret is a different token.
  const list = [record({ token: clear, hash: ultraTokenHash(clear) })];
  assert.equal(findUltraToken(list, clear), list[0]);
  assert.equal(findUltraToken(list, TOKEN), null);

  const sealed = composeUltraToken(TOKEN, mixed.skills, {
    encrypt: true,
    key: KEY,
    randomBytes: fixedBytes(4),
  });
  assert.match(sealed, new RegExp(`^${TOKEN}\\.e\\.[A-Za-z0-9_-]+$`));
  assert.ok(!sealed.includes('.s.'));
  assert.ok(!sealed.includes('Doctor'));
  assert.ok(!sealed.includes('dr.pm'));
  assert.deepEqual(readUltraTokenSkills(sealed), {
    encrypted: true,
    skills: [],
  });
  assert.deepEqual(ultraTokenSkillFields(sealed), { encrypted: true });
  assert.deepEqual(
    readUltraTokenSkills(sealed, KEY).skills.map((item) => item.code),
    ['dr', 'pm', 'rg', 'xcoast-guard', 'xswift-water'],
  );
  // The blob is bound to this secret: the same ciphertext on another token opens as nothing.
  const moved = TOKEN.slice(0, -1) + 'B' + sealed.slice(TOKEN.length);
  assert.deepEqual(readUltraTokenSkills(moved, KEY).skills, []);
  const empty = composeUltraToken(TOKEN, [], {
    encrypt: true,
    key: KEY,
    randomBytes: fixedBytes(4),
  });
  assert.match(empty, /\.e\./);
  assert.deepEqual(readUltraTokenSkills(empty, KEY), {
    encrypted: true,
    skills: [],
  });
  assert.equal(composeUltraToken(TOKEN, [], { encrypt: true }), null);

  const stored = normalizeUltraTokenRecord({
    ...record(),
    skills: [
      { code: 'dr', label: 'Not a doctor' },
      { code: 'xcoast-guard', label: 'Not what the link says' },
      { code: 'nope', label: 'Nope' },
    ],
    encrypted: true,
  });
  assert.deepEqual(stored.skills, [
    { code: 'dr', label: 'Doctor' },
    { code: 'xcoast-guard', label: 'Coast Guard' },
  ]);
  assert.equal(stored.encrypted, true);
  assert.equal(
    normalizeUltraTokenRecord({ ...record(), encrypted: 'yes' }).encrypted,
    false,
  );
});

test('an inbox row keeps its kind, entry, place, incident, window and SMS outcome, with defaults for an older row', () => {
  const release = {
    id: 'm-0123456789abcdef',
    tokenId: '',
    kind: 'release',
    networkId: 'n-0123456789abcdef',
    label: 'Sam',
    from: 'Van 7',
    number: '',
    text: 'Please HELP you are close by, to 10 Example St of victim in progress, fire thank you.',
    place: '10 Example St, Saint John, New Brunswick (45.2744, -66.0622)',
    incident: 'fire',
    lat: 45.2744,
    lon: -66.0622,
    at: NOW,
    until: NOW + 14_400_000,
    sms: 'SMS SENT 22:15',
    deliveredAt: null,
    readAt: null,
  };
  assert.deepEqual(normalizeUltraInboxRecord(release), release);
  // A row written before the fields existed reads as a message with the defaults.
  const legacy = normalizeUltraInboxRecord({
    id: 'm-0123456789abcdef',
    tokenId: ID,
    label: 'Neighbour',
    from: 'Sam',
    number: '+15065550100',
    text: 'help',
    lat: 1,
    lon: 2,
    at: NOW,
    deliveredAt: null,
    readAt: null,
  });
  assert.equal(legacy.kind, 'message');
  assert.equal(legacy.networkId, '');
  assert.equal(legacy.place, '');
  assert.equal(legacy.incident, '');
  assert.equal(legacy.until, null);
  assert.equal(legacy.sms, '');
  // Each field is checked on its own.
  const loose = normalizeUltraInboxRecord({
    ...release,
    kind: 'x',
    networkId: 'n-xyz',
    place: 'p'.repeat(200) + '\u0000',
    incident: 'bomb',
    until: 'later',
    sms: 's'.repeat(60),
  });
  assert.equal(loose.kind, 'message');
  assert.equal(loose.networkId, '');
  assert.equal(loose.place, 'p'.repeat(160));
  assert.equal(loose.incident, '');
  assert.equal(loose.until, null);
  assert.equal(loose.sms, 's'.repeat(40));
  assert.equal(
    normalizeUltraInboxRecord({ ...release, networkId: 'N-0123456789ABCDEF' })
      .networkId,
    '',
  );
  assert.equal(
    normalizeUltraInboxRecord({ ...release, networkId: 't-0123456789abcdef' })
      .networkId,
    '',
  );
  assert.equal(
    normalizeUltraInboxRecord({ ...release, until: String(NOW) }).until,
    NOW,
  );
  for (const incident of ['threat', 'fire', 'medical', 'other']) {
    assert.equal(
      normalizeUltraInboxRecord({ ...release, incident }).incident,
      incident,
    );
  }
  // The victim's number is never kept on a release row, even when a file carries one.
  assert.equal(
    normalizeUltraInboxRecord({ ...release, number: '+15065550100' }).number,
    '+15065550100',
  );
  assert.equal(
    ultraNotifyItem(
      normalizeUltraInboxRecord({ ...release, number: '+15065550100' }),
    ).number,
    '',
  );
});

test('a call’s inbox row keeps the window end its peer sent, and nothing else carries one', () => {
  const row = {
    id: 'm-0123456789abcdef',
    tokenId: '',
    kind: 'release',
    networkId: 'n-0123456789abcdef',
    label: 'Sam',
    from: 'Van 7',
    number: '',
    text: 'Please HELP you are close by, to 45.2744, -66.0622 of victim in progress, fire thank you.',
    place: '45.2744, -66.0622',
    incident: 'fire',
    lat: 45.2744,
    lon: -66.0622,
    at: NOW,
    until: NOW + 14_400_000,
    sms: '',
    deliveredAt: null,
    readAt: null,
    peerUntil: NOW + 14_395_000,
  };
  // Kept as it is, so a restart still knows which call the row is.
  assert.deepEqual(normalizeUltraInboxRecord(row), row);
  assert.equal(
    'peerUntil' in normalizeUltraInboxRecord({ ...row, peerUntil: 'soon' }),
    false,
  );
  assert.equal(
    'peerUntil' in normalizeUltraInboxRecord({ ...row, kind: 'message' }),
    false,
  );
  // It never leaves this machine: not on the card the phone is sent.
  assert.equal('peerUntil' in ultraNotifyItem(row), false);
});

test('ultraNotifyItem keeps the message shape byte for byte and yields the release shape for a call', () => {
  const message = normalizeUltraInboxRecord({
    id: 'm-0123456789abcdef',
    tokenId: ID,
    kind: 'message',
    label: 'Neighbour',
    from: 'Sam',
    number: '+15065550100',
    text: 'help',
    lat: 1,
    lon: 2,
    at: NOW,
    deliveredAt: null,
    readAt: null,
  });
  assert.deepEqual(ultraNotifyItem(message), {
    kind: 'notify',
    id: 'm-0123456789abcdef',
    label: 'Neighbour',
    from: 'Sam',
    number: '+15065550100',
    lat: 1,
    lon: 2,
    text: 'help',
    at: NOW,
  });
  assert.deepEqual(Object.keys(ultraNotifyItem(message)), [
    'kind',
    'id',
    'label',
    'from',
    'number',
    'lat',
    'lon',
    'text',
    'at',
  ]);
  const release = normalizeUltraInboxRecord({
    id: 'm-0123456789abcdef',
    kind: 'release',
    networkId: 'n-0123456789abcdef',
    label: 'Sam',
    from: 'Van 7',
    text: 'the plea',
    place: '10 Example St (45.2744, -66.0622)',
    incident: 'fire',
    lat: 45.2744,
    lon: -66.0622,
    at: NOW,
    until: NOW + 1000,
    sms: 'SMS SENT 22:15',
  });
  assert.deepEqual(ultraNotifyItem(release), {
    kind: 'release',
    id: 'm-0123456789abcdef',
    label: 'Sam',
    from: 'Van 7',
    number: '',
    lat: 45.2744,
    lon: -66.0622,
    text: 'the plea',
    place: '10 Example St (45.2744, -66.0622)',
    incident: 'fire',
    at: NOW,
    until: NOW + 1000,
    networkId: 'n-0123456789abcdef',
  });
  for (const key of ['tokenId', 'sms', 'deliveredAt', 'readAt']) {
    assert.equal(key in ultraNotifyItem(release), false, key);
  }
});

test('cleanPosition is exported for the help network and keeps only a usable pair', () => {
  assert.deepEqual(cleanPosition(45.27, -66.06), { lat: 45.27, lon: -66.06 });
  assert.deepEqual(cleanPosition('45.27', '-66.06'), {
    lat: 45.27,
    lon: -66.06,
  });
  assert.deepEqual(cleanPosition(0, 1), { lat: 0, lon: 1 });
  assert.deepEqual(cleanPosition(90, 180), { lat: 90, lon: 180 });
  assert.deepEqual(cleanPosition(-90, -180), { lat: -90, lon: -180 });
  for (const [lat, lon] of [
    [0, 0],
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
    [NaN, 1],
    [1, Infinity],
    ['north', 1],
    [null, 1],
    [1, undefined],
    ['', ''],
    [{}, 1],
    [[1, 2], 1],
  ]) {
    assert.deepEqual(
      cleanPosition(lat, lon),
      { lat: null, lon: null },
      `${lat},${lon}`,
    );
  }
});

test('an inbox check covers the text, and a bad row beside a good one is hidden', () => {
  const row = {
    id: 'm-0123456789abcdef',
    tokenId: ID,
    kind: 'message',
    networkId: '',
    label: 'Neighbour',
    from: 'Sam',
    number: '+15065550100',
    text: 'help',
    place: '',
    incident: '',
    lat: 45.27,
    lon: -66.06,
    at: NOW,
    until: null,
    sms: '',
    deliveredAt: null,
    readAt: null,
  };
  assert.deepEqual(normalizeUltraInboxRecord(row), row);
  const policyMac = ultraInboxPolicyMac(row, KEY);
  const stamped = { ...row, policyMac };
  assert.match(policyMac, /^[0-9a-f]{64}$/);
  assert.equal(ultraInboxPolicyState(stamped, KEY), 'ok');
  const flipped = { ...stamped, text: 'no' };
  assert.equal(ultraInboxPolicyState(flipped, KEY), 'bad');
  assert.equal(normalizeUltraInboxRecord(stamped).policyMac, policyMac);
  assert.equal(
    normalizeUltraInboxRecord({ ...row, policyMac: 'nope' }).policyMac,
    'bad',
  );
  assert.equal('policyMac' in normalizeUltraInboxRecord(row), false);
  const other = {
    ...row,
    id: 'm-0000000000000002',
    text: 'second',
  };
  const otherStamped = {
    ...other,
    policyMac: ultraInboxPolicyMac(other, KEY),
  };
  assert.deepEqual(
    ultraInboxVisibleMessages([flipped, otherStamped], KEY, {
      sealsOpen: true,
    }).map((item) => item.id),
    [otherStamped.id],
  );
  assert.deepEqual(
    ultraInboxVisibleMessages([row, other], KEY, { sealsOpen: true }).map(
      (item) => item.text,
    ),
    ['help', 'second'],
  );
  assert.deepEqual(
    ultraInboxVisibleMessages([row, otherStamped], KEY).map((item) => item.id),
    [otherStamped.id],
  );
  assert.deepEqual(
    ultraInboxVisibleMessages([flipped], KEY, { sealsOpen: false }).map(
      (item) => item.text,
    ),
    ['no'],
  );
  assert.deepEqual(
    ultraInboxVisibleMessages([flipped], KEY, { sealsOpen: true }),
    [],
  );
  assert.equal(ultraInboxVisibleMessages([flipped], null).length, 1);
});
