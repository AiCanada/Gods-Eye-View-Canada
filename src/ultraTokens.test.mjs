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
  ultraSubkeys,
  ultraTokenKeyId,
  ultraPolicyMacs,
  ultraPolicyMacVerify,
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
  ultraTokenStoreMac,
  ultraTokenStoreState,
  stampUltraTokenStore,
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
} from '../server/shared/ultraTokens.mjs';

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
  // An injected generator counts up, so the key is not a run of one byte.
  const counting = (n) => Buffer.from(Array.from({ length: n }, (_, i) => i));
  const keyHex = counting(32).toString('hex');
  const text = newUltraTokenKeyText(counting);
  assert.equal(text, keyHex + '\n');
  assert.deepEqual(parseUltraTokenKey(text), counting(32));
  assert.deepEqual(parseUltraTokenKey('  ' + keyHex + ' \r\n'), counting(32));
  assert.equal(parseUltraTokenKey(keyHex.slice(1)), null);
  assert.equal(parseUltraTokenKey(keyHex + 'a'), null);
  assert.equal(parseUltraTokenKey('5g'.repeat(32)), null);
  assert.equal(parseUltraTokenKey(''), null);
  assert.equal(parseUltraTokenKey(null), null);
  assert.match(newUltraTokenKeyText(), /^[0-9a-f]{64}\n$/);
  assert.notEqual(newUltraTokenKeyText(), newUltraTokenKeyText());
  // The tagged form reads to the same key; the bare form is still what is written.
  assert.deepEqual(parseUltraTokenKey('ultra-key:v1:' + keyHex), counting(32));
  assert.deepEqual(
    parseUltraTokenKey(' ultra-key:v1: ' + keyHex + '\n'),
    counting(32),
  );
  assert.equal(parseUltraTokenKey('ultra-key:v2:' + keyHex), null);
  assert.equal(parseUltraTokenKey('ULTRA-KEY:V1:' + keyHex), null);
  assert.equal(parseUltraTokenKey('ultra-key:v1:'), null);
  assert.doesNotMatch(newUltraTokenKeyText(), /^ultra-key/);
  // A key of one repeated byte is a zeroed or stubbed file, not a key.
  assert.equal(parseUltraTokenKey('00'.repeat(32)), null);
  assert.equal(parseUltraTokenKey('5a'.repeat(32)), null);
  assert.equal(parseUltraTokenKey('ultra-key:v1:' + 'ff'.repeat(32)), null);
  assert.equal(newUltraTokenKeyText(fixedBytes(0x5a)), '5a'.repeat(32) + '\n');
  assert.deepEqual(
    parseUltraTokenKey('5a'.repeat(31) + '5b'),
    Buffer.from('5a'.repeat(31) + '5b', 'hex'),
  );
});

test('the master key derives one AES subkey and one HMAC subkey, and has a short id', () => {
  const sub = ultraSubkeys(KEY);
  assert.deepEqual(Object.keys(sub).sort(), ['enc', 'mac']);
  assert.equal(sub.enc.length, 32);
  assert.equal(sub.mac.length, 32);
  assert.notDeepEqual(sub.enc, sub.mac);
  assert.notDeepEqual(sub.enc, KEY);
  assert.notDeepEqual(sub.mac, KEY);
  const salt = Buffer.from('ultra-tokens:v2', 'utf8');
  const hkdf = (info) =>
    Buffer.from(
      crypto.hkdfSync('sha256', KEY, salt, Buffer.from(info, 'utf8'), 32),
    );
  assert.deepEqual(sub.enc, hkdf('ultra-token:aes-256-gcm'));
  assert.deepEqual(sub.mac, hkdf('ultra-token:hmac-sha256'));
  // Same master, same subkeys, and a copy each time: changing one is harmless.
  const again = ultraSubkeys(KEY);
  assert.deepEqual(again, sub);
  again.enc[0] ^= 0xff;
  assert.deepEqual(ultraSubkeys(KEY).enc, sub.enc);
  assert.notDeepEqual(ultraSubkeys(OTHER_KEY), sub);
  // The cache is bounded and does not change results once it rolls over.
  for (let i = 0; i < 40; i += 1) ultraSubkeys(Buffer.alloc(32, i + 100));
  assert.deepEqual(ultraSubkeys(KEY), sub);
  for (const bad of [null, 'text', Buffer.alloc(16), Buffer.alloc(33), {}]) {
    assert.equal(ultraSubkeys(bad), null);
  }
  const id = ultraTokenKeyId(KEY);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(
    id,
    crypto
      .createHmac('sha256', KEY)
      .update('ultra-tokens:key-id:v1', 'utf8')
      .digest('hex')
      .slice(0, 16),
  );
  assert.notEqual(id, ultraTokenKeyId(OTHER_KEY));
  assert.equal(ultraTokenKeyId(null), '');
  assert.equal(ultraTokenKeyId(Buffer.alloc(16)), '');
  assert.equal(ultraTokenKeyId('text'), '');
  // Nothing of the key itself is in its id or its subkeys.
  assert.ok(!KEY.toString('hex').includes(id));
});

test('seal and open round-trip under the key and the record id', () => {
  const sealed = sealUltraToken(TOKEN, KEY, {
    id: ID,
    randomBytes: fixedBytes(3),
  });
  assert.equal(sealed.v, 2);
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
  // The v2 seal is under the derived key, not the master key itself.
  const sub = ultraSubkeys(KEY);
  const direct = crypto.createDecipheriv(
    'aes-256-gcm',
    sub.enc,
    Buffer.from(sealed.iv, 'base64'),
  );
  direct.setAAD(Buffer.from('ultra-token:' + ID, 'utf8'));
  direct.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  assert.equal(
    Buffer.concat([
      direct.update(Buffer.from(sealed.data, 'base64')),
      direct.final(),
    ]).toString('utf8'),
    TOKEN,
  );
  assert.throws(() => {
    const raw = crypto.createDecipheriv(
      'aes-256-gcm',
      KEY,
      Buffer.from(sealed.iv, 'base64'),
    );
    raw.setAAD(Buffer.from('ultra-token:' + ID, 'utf8'));
    raw.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    raw.update(Buffer.from(sealed.data, 'base64'));
    raw.final();
  });
});

/** A seal exactly as the build before key separation wrote it: v 1, AES-256-GCM under the master key itself. */
function legacySeal(
  token,
  key,
  id,
  iv = Buffer.alloc(12, 3),
  aad = 'ultra-token:',
) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad + id, 'utf8'));
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

test('a v 1 seal made under the master key still opens, and is kept as v 1', () => {
  const old = legacySeal(TOKEN, KEY, ID);
  assert.equal(openUltraToken(old, KEY, { id: ID }), TOKEN);
  assert.equal(openUltraToken(old, OTHER_KEY, { id: ID }), null);
  assert.equal(openUltraToken(old, KEY, { id: 't-0000000000000000' }), null);
  // The version says which key: a v 1 blob is never tried under the derived key, nor a v 2 blob under the master key.
  assert.equal(openUltraToken({ ...old, v: 2 }, KEY, { id: ID }), null);
  const fresh = sealUltraToken(TOKEN, KEY, {
    id: ID,
    randomBytes: fixedBytes(3),
  });
  assert.equal(openUltraToken({ ...fresh, v: 1 }, KEY, { id: ID }), null);
  assert.equal(openUltraToken({ ...old, v: 3 }, KEY, { id: ID }), null);
  assert.equal(openUltraToken({ ...old, v: 0 }, KEY, { id: ID }), null);
  // Same iv and token: the two versions differ in every sealed byte, so the key really changed.
  assert.equal(old.iv, fresh.iv);
  assert.notEqual(old.data, fresh.data);
  assert.notEqual(old.tag, fresh.tag);
  // A stored v 1 record is normalised as v 1 and still verifies.
  const stored = normalizeUltraTokenRecord({ ...record(), sealed: old });
  assert.equal(stored.sealed.v, 1);
  assert.deepEqual(stored.sealed, old);
  assert.equal(ultraTokenRecordVerdict(stored, KEY), 'legacy');
  assert.equal(
    ultraTokenRecordVerdict(stampUltraTokenPolicy(stored, KEY), KEY),
    'ok',
  );
  assert.deepEqual(ultraTokenDisplayedSkills(stored, KEY), {
    skills: [],
    encrypted: false,
  });
  assert.equal(selectUltraToken([stored], TOKEN, KEY).tampered, false);
  // A home-list v 1 seal opens with its own prefix too.
  const home = legacySeal(
    TOKEN,
    KEY,
    ID,
    Buffer.alloc(12, 3),
    'ultra-network:',
  );
  assert.equal(
    openUltraToken(home, KEY, { id: ID, aad: 'ultra-network:' }),
    TOKEN,
  );
  assert.equal(openUltraToken(home, KEY, { id: ID }), null);
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
  assert.equal(openUltraToken({ ...sealed, v: 3 }, KEY, { id: ID }), null);
  assert.equal(openUltraToken({ ...sealed, v: 1 }, KEY, { id: ID }), null);
  assert.equal(openUltraToken({ ...sealed, v: '2' }, KEY, { id: ID }), null);
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
  // Sealing refuses anything but a 32-byte Buffer: a 32-character string
  // would be taken by the cipher as raw key bytes and written as v 2, a blob
  // no derived key opens. Nothing is ever sealed under the master key again.
  for (const notKey of [
    KEY.toString('hex').slice(0, 32),
    Buffer.alloc(16),
    null,
    undefined,
    KEY.toString('hex'),
  ])
    assert.throws(() => sealUltraToken(TOKEN, notKey, { id: ID }), TypeError);
  assert.equal(
    composeUltraToken(TOKEN, ['dr'], { encrypt: true, key: Buffer.alloc(16) }),
    null,
  );
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
    { ...good, sealed: { ...good.sealed, v: 3 } },
    { ...good, sealed: { ...good.sealed, v: '2' } },
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
  const moduleUrl = new URL('../server/shared/ultraTokens.mjs', import.meta.url)
    .href;
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
  assert.equal(ULTRA_SKILL_SETS.length, 15);
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
    hidden: true,
  });
  assert.deepEqual(readUltraTokenSkills(sealed, OTHER_KEY), {
    encrypted: true,
    skills: [],
    hidden: true,
  });
  assert.equal('hidden' in readUltraTokenSkills(sealed, KEY), false);
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

test('Transportation is a token skill, beside every other skill and five custom ones', async () => {
  const { ULTRA_SKILL_SETS, ULTRA_TOKEN_PATTERN } =
    await import('../server/shared/ultraTokens.mjs');
  assert.deepEqual(
    ULTRA_SKILL_SETS.find((item) => item.code === 'tr'),
    { code: 'tr', label: 'Transportation' },
  );
  const body = 'uht1.' + 'A'.repeat(43);
  const every = [
    ...ULTRA_SKILL_SETS.map((item) => item.code),
    'xa',
    'xb',
    'xc',
    'xd',
    'xe',
  ];
  assert.equal(every.length, 20);
  assert.ok(ULTRA_TOKEN_PATTERN.test(`${body}.s.${every.join('.')}`));
  assert.ok(ULTRA_TOKEN_PATTERN.test(`${body}.s.tr`));
  assert.ok(
    !ULTRA_TOKEN_PATTERN.test(`${body}.s.${[...every, 'xf'].join('.')}`),
  );
});

/** A policy check exactly as the build before key separation wrote it: HMAC under the master key over the v1 canonical form. */
function legacyPolicyMac(record, key) {
  const text = [
    'ultra-token-policy:v1',
    `${Buffer.byteLength(record.id)}:${record.id}`,
    `${Buffer.byteLength(record.feedId)}:${record.feedId}`,
    `${Buffer.byteLength(record.label)}:${record.label}`,
    record.sms === true ? '1' : '0',
    record.voice === true ? '1' : '0',
    record.network === true ? '1' : '0',
    record.anytime === true ? '1' : '0',
    record.locationOnly === true ? '1' : '0',
    record.encrypted === true ? '1' : '0',
    typeof record.revokedAt === 'number' ? String(record.revokedAt) : '-',
    `${Buffer.byteLength(record.hash)}:${record.hash}`,
  ].join('\n');
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

test('a policy check written under the master key is still accepted, and stamping writes the derived one', () => {
  const good = normalizeUltraTokenRecord(record());
  const legacy = { ...good, policyMac: legacyPolicyMac(good, KEY) };
  assert.equal(ultraTokenPolicyState(legacy, KEY), 'ok');
  assert.equal(ultraTokenRecordVerdict(legacy, KEY), 'ok');
  assert.equal(ultraTokenPolicyState(legacy, OTHER_KEY), 'bad');
  assert.equal(ultraTokenPolicyState({ ...legacy, sms: false }, KEY), 'bad');
  // The derived check is a different value, under the MAC subkey, over the v2 form (createdAt included).
  const derived = ultraTokenPolicyMac(good, KEY);
  assert.notEqual(derived, legacy.policyMac);
  const canonicalV2 = [
    'ultra-token-policy:v2',
    `${good.id.length}:${good.id}`,
    `${good.feedId.length}:${good.feedId}`,
    `${good.label.length}:${good.label}`,
    '1',
    '1',
    '0',
    '0',
    '0',
    '0',
    '-',
    String(good.createdAt),
    `${good.hash.length}:${good.hash}`,
  ].join('\n');
  assert.equal(
    derived,
    crypto
      .createHmac('sha256', ultraSubkeys(KEY).mac)
      .update(canonicalV2, 'utf8')
      .digest('hex'),
  );
  const restamped = stampUltraTokenPolicy(legacy, KEY);
  assert.equal(restamped.policyMac, derived);
  assert.equal(ultraTokenPolicyState(restamped, KEY), 'ok');
  // v2 covers createdAt; a check under the v1 form never did.
  assert.equal(
    ultraTokenPolicyState({ ...restamped, createdAt: NOW }, KEY),
    'bad',
  );
  assert.equal(ultraTokenPolicyState({ ...legacy, createdAt: NOW }, KEY), 'ok');
  // The v1 form under the derived key is accepted too, as is the v2 form under the master key: four candidates.
  const macs = ultraPolicyMacs(KEY, ['a', 'b']);
  assert.equal(macs.length, 4);
  assert.ok(macs.every((mac) => /^[0-9a-f]{64}$/.test(mac)));
  assert.equal(new Set(macs).size, 4);
  assert.equal(
    macs[0],
    crypto
      .createHmac('sha256', ultraSubkeys(KEY).mac)
      .update('a', 'utf8')
      .digest('hex'),
  );
  assert.equal(
    macs[2],
    crypto.createHmac('sha256', KEY).update('a', 'utf8').digest('hex'),
  );
  assert.deepEqual(ultraPolicyMacs(KEY, 'a'), ultraPolicyMacs(KEY, ['a']));
  assert.deepEqual(ultraPolicyMacs(null, ['a']), []);
  assert.deepEqual(ultraPolicyMacs(Buffer.alloc(16), ['a']), []);
  for (const mac of macs) assert.equal(ultraPolicyMacVerify(mac, macs), true);
  assert.equal(ultraPolicyMacVerify(macs[1], [macs[0]]), false);
  assert.equal(ultraPolicyMacVerify(macs[0], macs[0]), true);
  assert.equal(ultraPolicyMacVerify('bad', macs), false);
  assert.equal(ultraPolicyMacVerify('', macs), false);
  assert.equal(ultraPolicyMacVerify(null, macs), false);
  assert.equal(ultraPolicyMacVerify(macs[0], []), false);
  assert.equal(ultraPolicyMacVerify(macs[0], ['bad', null]), false);
  assert.equal(ultraPolicyMacVerify(macs[0].toUpperCase(), macs), false);
  assert.equal(ultraPolicyMacVerify('0'.repeat(64), ['0'.repeat(64)]), true);
  assert.equal(ultraPolicyMacVerify('0'.repeat(64), ['nope']), false);
  // Inbox rows: the same two-key acceptance, the same derived restamp.
  const row = {
    id: 'm-0123456789abcdef',
    tokenId: ID,
    kind: 'message',
    networkId: '',
    label: 'Neighbour',
    from: 'Sam',
    number: '',
    text: 'Hi',
    place: '',
    incident: '',
    lat: null,
    lon: null,
    at: NOW,
    until: null,
    sms: '',
    deliveredAt: null,
    readAt: null,
  };
  const inboxCanonical = [
    'ultra-inbox-policy:v1',
    `${row.id.length}:${row.id}`,
    `${row.tokenId.length}:${row.tokenId}`,
    '7:message',
    '0:',
    '9:Neighbour',
    '3:Sam',
    '0:',
    '2:Hi',
    '0:',
    '0:',
    '-',
    '-',
    String(NOW),
    '-',
    '0:',
    '-',
    '-',
    '-',
  ].join('\n');
  const legacyRow = {
    ...row,
    policyMac: crypto
      .createHmac('sha256', KEY)
      .update(inboxCanonical, 'utf8')
      .digest('hex'),
  };
  assert.equal(ultraInboxPolicyState(legacyRow, KEY), 'ok');
  assert.equal(ultraInboxPolicyState(legacyRow, OTHER_KEY), 'bad');
  assert.equal(ultraInboxPolicyState({ ...legacyRow, text: 'Ho' }, KEY), 'bad');
  const derivedRow = ultraInboxPolicyMac(row, KEY);
  assert.notEqual(derivedRow, legacyRow.policyMac);
  assert.equal(
    derivedRow,
    crypto
      .createHmac('sha256', ultraSubkeys(KEY).mac)
      .update(inboxCanonical, 'utf8')
      .digest('hex'),
  );
  assert.equal(
    ultraInboxPolicyState({ ...row, policyMac: derivedRow }, KEY),
    'ok',
  );
  assert.deepEqual(
    ultraInboxVisibleMessages(
      [legacyRow, { ...row, policyMac: derivedRow }],
      KEY,
    ),
    [legacyRow, { ...row, policyMac: derivedRow }],
  );
});

test('the store keeps a well-formed keyId and omits anything else, so an older file still deep-equals', () => {
  const good = normalizeUltraTokenRecord(record());
  const plain = normalizeUltraTokenStore({ version: 1, tokens: [good] });
  assert.deepEqual(plain, { version: 1, tokens: [good] });
  assert.equal('keyId' in plain, false);
  const keyId = ultraTokenKeyId(KEY);
  const kept = normalizeUltraTokenStore({ version: 1, keyId, tokens: [good] });
  assert.deepEqual(kept, { version: 1, keyId, tokens: [good] });
  assert.deepEqual(Object.keys(kept), ['version', 'keyId', 'tokens']);
  for (const bad of [
    '',
    null,
    7,
    keyId.toUpperCase(),
    keyId.slice(1),
    keyId + 'a',
    'g'.repeat(16),
    { keyId },
  ]) {
    assert.deepEqual(
      normalizeUltraTokenStore({ version: 1, keyId: bad, tokens: [good] }),
      { version: 1, tokens: [good] },
      JSON.stringify(bad),
    );
  }
  assert.deepEqual(normalizeUltraTokenStore({ keyId }), {
    version: 1,
    keyId,
    tokens: [],
  });
  assert.deepEqual(normalizeUltraTokenStore(null), { version: 1, tokens: [] });
});

/** A `.e.` blob exactly as the build before the version byte wrote it: iv, tag and data under the master key. */
function legacySkillBlob(payload, key, secret, iv = Buffer.alloc(12, 4)) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('ultra-token-skills:' + secret.slice(5), 'utf8'));
  const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

test('a sealed skill blob is versioned and under the derived key; a blob without the byte still opens', () => {
  const skills = [
    { code: 'dr', label: 'Doctor' },
    { code: 'xcoast-guard', label: 'Coast Guard' },
  ];
  const sealed = composeUltraToken(TOKEN, skills, {
    encrypt: true,
    key: KEY,
    randomBytes: fixedBytes(4),
  });
  const blob = Buffer.from(sealed.slice(51), 'base64url');
  assert.equal(blob[0], 2);
  assert.equal(blob.length, 1 + 12 + 16 + 'dr.xcoast-guard'.length);
  assert.deepEqual(blob.subarray(1, 13), Buffer.alloc(12, 4));
  // The same codes under the master key, as the build before wrote them.
  const old = `${TOKEN}.e.${legacySkillBlob('dr.xcoast-guard', KEY, TOKEN)}`;
  assert.notEqual(old, sealed);
  assert.match(old, ULTRA_TOKEN_PATTERN);
  assert.deepEqual(readUltraTokenSkills(old, KEY), {
    encrypted: true,
    skills,
  });
  assert.deepEqual(readUltraTokenSkills(old, OTHER_KEY), {
    encrypted: true,
    skills: [],
    hidden: true,
  });
  assert.deepEqual(readUltraTokenSkills(sealed, KEY), {
    encrypted: true,
    skills,
  });
  // A legacy blob whose random iv happens to start with 0x02 is still opened as a legacy blob.
  const ivTwo = Buffer.concat([Buffer.from([2]), Buffer.alloc(11, 9)]);
  const lucky = `${TOKEN}.e.${legacySkillBlob('dr', KEY, TOKEN, ivTwo)}`;
  assert.equal(Buffer.from(lucky.slice(51), 'base64url')[0], 2);
  assert.deepEqual(
    readUltraTokenSkills(lucky, KEY).skills.map((item) => item.code),
    ['dr'],
  );
  // The shortest and the longest blob the pattern admits: 28 bytes (legacy, empty payload) to 203 bytes (v2, every code).
  const shortest = `${TOKEN}.e.${legacySkillBlob('', KEY, TOKEN)}`;
  assert.equal(shortest.slice(51).length, 38);
  assert.match(shortest, ULTRA_TOKEN_PATTERN);
  assert.deepEqual(readUltraTokenSkills(shortest, KEY), {
    encrypted: true,
    skills: [],
  });
  const every = [
    ...ULTRA_SKILL_SETS.map((item) => ({ code: item.code, label: item.label })),
    ...['a', 'b', 'c', 'd', 'e'].map((letter) => ({
      code: 'x' + letter + '-' + 'z'.repeat(21) + letter,
      label: 'Custom',
    })),
  ];
  const longest = composeUltraToken(TOKEN, every, {
    encrypt: true,
    key: KEY,
    randomBytes: fixedBytes(4),
  });
  assert.ok(longest, 'every code fits');
  assert.equal(Buffer.from(longest.slice(51), 'base64url').length, 203);
  assert.equal(longest.slice(51).length, 271);
  assert.match(longest, ULTRA_TOKEN_PATTERN);
  assert.equal(readUltraTokenSkills(longest, KEY).skills.length, 20);
  assert.doesNotMatch(longest + 'A', ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch(`${TOKEN}.e.${'A'.repeat(37)}`, ULTRA_TOKEN_PATTERN);
});

test('the owner row says when encrypted skills are hidden from this key, and not when there are none', () => {
  const hiddenToken = composeUltraToken(
    newUltraToken(fixedBytes(5)),
    [{ code: 'dr', label: 'Doctor' }],
    { encrypt: true, key: KEY, randomBytes: fixedBytes(4) },
  );
  const hidden = normalizeUltraTokenRecord({
    ...record({ id: 't-5555555555555555', token: hiddenToken }),
    encrypted: true,
  });
  assert.deepEqual(ultraTokenDisplayedSkills(hidden, KEY), {
    skills: [{ code: 'dr', label: 'Doctor' }],
    encrypted: true,
  });
  assert.deepEqual(ultraTokenDisplayedSkills(hidden, null), {
    skills: [],
    encrypted: true,
    hidden: true,
  });
  assert.deepEqual(ultraTokenDisplayedSkills(hidden, OTHER_KEY), {
    skills: [],
    encrypted: true,
    hidden: true,
  });
  // The seal opens but the blob inside was made under another key: still hidden.
  const foreignToken = composeUltraToken(
    newUltraToken(fixedBytes(5)),
    [{ code: 'dr', label: 'Doctor' }],
    { encrypt: true, key: OTHER_KEY, randomBytes: fixedBytes(4) },
  );
  const foreign = normalizeUltraTokenRecord({
    ...record({ id: 't-6666666666666666', token: foreignToken }),
    encrypted: true,
  });
  assert.deepEqual(ultraTokenDisplayedSkills(foreign, KEY), {
    skills: [],
    encrypted: true,
    hidden: true,
  });
  // Sealed with no skills at all: encrypted, opened, nothing hidden.
  const noneToken = composeUltraToken(newUltraToken(fixedBytes(6)), [], {
    encrypt: true,
    key: KEY,
    randomBytes: fixedBytes(4),
  });
  const none = normalizeUltraTokenRecord({
    ...record({ id: 't-7777777777777777', token: noneToken }),
    encrypted: true,
  });
  assert.deepEqual(ultraTokenDisplayedSkills(none, KEY), {
    skills: [],
    encrypted: true,
  });
  assert.deepEqual(ultraTokenDisplayedSkills(none, null), {
    skills: [],
    encrypted: true,
    hidden: true,
  });
  assert.deepEqual(readUltraTokenSkills(noneToken, KEY), {
    encrypted: true,
    skills: [],
  });
  // A clear token never says hidden, with or without the key.
  const clear = normalizeUltraTokenRecord(record());
  assert.deepEqual(ultraTokenDisplayedSkills(clear, KEY), {
    skills: [],
    encrypted: false,
  });
  assert.deepEqual(ultraTokenDisplayedSkills(clear, null), {
    skills: [],
    encrypted: false,
  });
  // What a peer sees from the link is unchanged: no hidden field there.
  assert.deepEqual(ultraTokenSkillFields(hiddenToken), { encrypted: true });
});

test('the system generator is refused when a draw has too few distinct bytes or repeats the last one', () => {
  const real = crypto.randomBytes;
  const fill = (values) => (n) =>
    Buffer.from(Array.from({ length: n }, (_, i) => values[i % values.length]));
  try {
    // Two values across 32 bytes: not what 256 bits of entropy looks like.
    crypto.randomBytes = fill([0, 1]);
    assert.throws(() => newUltraToken(), /not returning usable bytes/);
    // Seven values is still under the floor of eight for 32 bytes; eight passes.
    crypto.randomBytes = fill([0, 1, 2, 3, 4, 5, 6]);
    assert.throws(() => newUltraToken(), /not returning usable bytes/);
    crypto.randomBytes = fill([0, 1, 2, 3, 4, 5, 6, 7]);
    assert.match(newUltraToken(), ULTRA_TOKEN_PATTERN);
    // 8-byte ids need three values; 12-byte ivs need four.
    crypto.randomBytes = fill([0, 1]);
    assert.throws(() => ultraTokenId(), /not returning usable bytes/);
    crypto.randomBytes = fill([0, 1, 2]);
    assert.match(ultraTokenId(), /^t-[0-9a-f]{16}$/);
    assert.throws(
      () => sealUltraToken(TOKEN, KEY, { id: ID }),
      /not returning usable bytes/,
    );
    crypto.randomBytes = fill([0, 1, 2, 3]);
    assert.equal(
      openUltraToken(sealUltraToken(TOKEN, KEY, { id: ID }), KEY, { id: ID }),
      TOKEN,
    );
    // A generator stuck on one (otherwise fine) draw is refused the second time.
    const stuck = real(32);
    crypto.randomBytes = () => Buffer.from(stuck);
    assert.match(newUltraToken(), ULTRA_TOKEN_PATTERN);
    assert.throws(() => newUltraToken(), /not returning usable bytes/);
    // One repeat and then fresh bytes is a redraw, not a failure.
    let calls = 0;
    crypto.randomBytes = (n) =>
      (calls += 1) === 1 ? Buffer.from(stuck) : real(n);
    assert.match(newUltraToken(), ULTRA_TOKEN_PATTERN);
    assert.equal(calls, 2);
    // Lengths are policed apart: the last 32-byte draw does not refuse an 8-byte one.
    crypto.randomBytes = (n) => Buffer.from(stuck.subarray(0, n));
    assert.match(ultraTokenId(), /^t-[0-9a-f]{16}$/);
  } finally {
    crypto.randomBytes = real;
  }
  // An injected generator is never policed: these bytes are the test's own.
  assert.equal(newUltraToken(fixedBytes(0)), 'uht1.' + 'A'.repeat(43));
  assert.equal(newUltraToken(fixedBytes(0)), 'uht1.' + 'A'.repeat(43));
  assert.equal(ultraTokenId(fixedBytes(0xab)), ID);
});

test('cleanHelpText strips exactly the shared hidden set from ultraHelp.mjs', async () => {
  const { ULTRA_HIDDEN_TEXT, ultraHiddenText } =
    await import('./ultraHelp.mjs');
  const sample = '‮A​B⁦C⁩D﻿E\u0007F\u0085G؜H';
  assert.equal(cleanHelpText(sample), 'ABCDEFGH');
  assert.equal(sample.replace(ultraHiddenText(), ''), 'ABCDEFGH');
  assert.equal(
    sample.replace(new RegExp(`[${ULTRA_HIDDEN_TEXT}]`, 'g'), ''),
    'ABCDEFGH',
  );
  // Calling it twice in a row gives the same answer: no shared lastIndex.
  assert.equal(cleanHelpText(sample), 'ABCDEFGH');
  assert.equal(cleanHelpText('a\tb\nc', 10, { lines: true }), 'a b\nc');
});

test('the store-wide check covers the key id, the count, each row in order and its own check', () => {
  const a = stampUltraTokenPolicy(
    normalizeUltraTokenRecord(record({ id: 't-' + 'a'.repeat(16) })),
    KEY,
  );
  const b = stampUltraTokenPolicy(
    normalizeUltraTokenRecord(
      record({ id: 't-' + 'b'.repeat(16), hash: 'b'.repeat(64) }),
    ),
    KEY,
  );
  const store = { version: 1, keyId: ultraTokenKeyId(KEY), tokens: [a, b] };
  assert.equal(ultraTokenStoreState(store, KEY), 'legacy');
  const stamped = stampUltraTokenStore(store, KEY);
  assert.deepEqual(Object.keys(stamped), [
    'version',
    'keyId',
    'storeMac',
    'tokens',
  ]);
  assert.match(stamped.storeMac, /^[0-9a-f]{64}$/);
  assert.equal(stamped.storeMac, ultraTokenStoreMac(store, KEY));
  assert.equal(ultraTokenStoreState(stamped, KEY), 'ok');
  // Written under the MAC subkey, never the master key itself.
  assert.equal(
    stamped.storeMac,
    ultraPolicyMacs(KEY, ['x'])[0].length === 64 && stamped.storeMac,
  );
  assert.notEqual(
    stamped.storeMac,
    crypto
      .createHmac('sha256', KEY)
      .update('ultra-token-store:v1')
      .digest('hex'),
  );
  // A row removed, reordered, copied in, revoked by hand, or stripped of its
  // own check, and a key id edited, each fail the check.
  const changed = [
    { ...stamped, tokens: [a] },
    { ...stamped, tokens: [b, a] },
    { ...stamped, tokens: [a, b, { ...a, id: 't-' + 'c'.repeat(16) }] },
    { ...stamped, tokens: [a, { ...b, revokedAt: 5 }] },
    { ...stamped, tokens: [a, { ...b, policyMac: undefined }] },
    { ...stamped, tokens: [{ ...a, hash: 'c'.repeat(64) }, b] },
    { ...stamped, keyId: ultraTokenKeyId(Buffer.alloc(32, 1)) },
  ];
  for (const edited of changed)
    assert.equal(ultraTokenStoreState(edited, KEY), 'bad');
  // A wrong key, no key, or a malformed check is bad; absent is legacy.
  assert.equal(ultraTokenStoreState(stamped, Buffer.alloc(32, 1)), 'bad');
  assert.equal(ultraTokenStoreState(stamped, null), 'bad');
  assert.equal(
    ultraTokenStoreState({ ...stamped, storeMac: 'bad' }, KEY),
    'bad',
  );
  for (const none of [undefined, null, ''])
    assert.equal(
      ultraTokenStoreState({ ...stamped, storeMac: none }, KEY),
      'legacy',
    );
  // Stamping again replaces the check rather than keeping a stale one.
  const restamped = stampUltraTokenStore({ ...stamped, tokens: [a] }, KEY);
  assert.equal(ultraTokenStoreState(restamped, KEY), 'ok');
  assert.notEqual(restamped.storeMac, stamped.storeMac);
  // Without a usable key the store is returned as it was.
  assert.equal(stampUltraTokenStore(store, null), store);
  assert.equal(ultraTokenStoreMac(store, Buffer.alloc(16)), '');
  // The empty store has a check too, so a file emptied by hand is told.
  const empty = stampUltraTokenStore({ version: 1, tokens: [] }, KEY);
  assert.equal(ultraTokenStoreState(empty, KEY), 'ok');
  assert.equal(ultraTokenStoreState({ ...empty, tokens: [a] }, KEY), 'bad');
});

test('the store keeps a well-formed storeMac, keeps a malformed one as bad, and omits an absent one', () => {
  const good = normalizeUltraTokenRecord(record());
  const plain = normalizeUltraTokenStore({ version: 1, tokens: [good] });
  assert.equal('storeMac' in plain, false);
  const mac = 'c'.repeat(64);
  const kept = normalizeUltraTokenStore({
    version: 1,
    keyId: ultraTokenKeyId(KEY),
    storeMac: mac,
    tokens: [good],
  });
  assert.deepEqual(Object.keys(kept), [
    'version',
    'keyId',
    'storeMac',
    'tokens',
  ]);
  assert.equal(kept.storeMac, mac);
  for (const none of ['', null, undefined])
    assert.equal(
      'storeMac' in
        normalizeUltraTokenStore({ version: 1, storeMac: none, tokens: [] }),
      false,
    );
  for (const bad of ['x', 7, mac.toUpperCase(), mac.slice(1), {}, []])
    assert.equal(
      normalizeUltraTokenStore({ version: 1, storeMac: bad, tokens: [] })
        .storeMac,
      'bad',
    );
  assert.equal(
    ultraTokenStoreState(
      normalizeUltraTokenStore({ version: 1, storeMac: 'x', tokens: [] }),
      KEY,
    ),
    'bad',
  );
});
