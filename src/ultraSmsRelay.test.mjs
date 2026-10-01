import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  ULTRA_SMS_BODY_LIMIT,
  ULTRA_SMS_RENOTIFY_MS,
  ULTRA_SMS_DAILY_LIMIT,
  ULTRA_SMS_OWN_RESERVE,
  ULTRA_SMS_TEST_MS,
  ULTRA_SMS_TIMEOUT_MS,
  ULTRA_SMS_HOST_LIMIT,
  ULTRA_SMS_TEST_TEXT,
  ULTRA_SMS_NO_RELAY,
  ULTRA_SMS_NO_NUMBER,
  ULTRA_SMS_SENDING,
  ULTRA_SMS_UNKNOWN,
  ULTRA_SMS_TWILIO_HOST,
  ULTRA_SMS_USER_AGENT,
  ultraSmsRelayConfig,
  ultraSmsRelayPublic,
  ultraSmsRelayBody,
  ultraSmsRelayRequest,
  newUltraSmsLedger,
  ultraSmsRelayAllowed,
  ultraSmsSentToday,
  ultraSmsFailureCode,
  ultraSmsOutcome,
  ultraSmsRelayForget,
  ultraOwnSmsOutcome,
  ULTRA_SMS_RETRY_MS,
} from './ultraSmsRelay.mjs';
import { ULTRA_HELP_CONTACT_LIMIT, ultraHelpMessage } from './ultraHelp.mjs';

const NOW = Date.parse('2026-09-28T18:00:00Z');
const SID = 'AC' + '0123456789abcdef'.repeat(2);
const AUTH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FROM = '+15065550199';
const OWNER = '+15065550100';
const TWILIO = {
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: AUTH,
  TWILIO_FROM_NUMBER: FROM,
};
const GATEWAY_URL = 'https://sms.example.net/send';
const GATEWAY_TOKEN = 'gw-secret-0123';
const GENERIC = {
  ULTRA_SMS_RELAY_URL: GATEWAY_URL,
  ULTRA_SMS_RELAY_TOKEN: GATEWAY_TOKEN,
};
const PLACE = '10 Example St, Saint John, New Brunswick (45.2744, -66.0622)';
const PLEA = ultraHelpMessage(PLACE, 'fire');
const SECRETS = [SID, AUTH, FROM, GATEWAY_TOKEN];

const hhmm = (ms) => {
  const d = new Date(ms);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0')
  );
};

test('the constants are the numbers and words the design quotes', () => {
  assert.equal(ULTRA_SMS_BODY_LIMIT, 320);
  assert.equal(ULTRA_SMS_RENOTIFY_MS, 600_000);
  assert.equal(ULTRA_SMS_DAILY_LIMIT, 50);
  // The reserve is a whole PREDEFINED HELP # list, so it always goes out.
  assert.equal(ULTRA_HELP_CONTACT_LIMIT, 20);
  assert.ok(ULTRA_SMS_OWN_RESERVE >= ULTRA_HELP_CONTACT_LIMIT);
  assert.ok(ULTRA_SMS_OWN_RESERVE < ULTRA_SMS_DAILY_LIMIT);
  assert.equal(ULTRA_SMS_TEST_MS, 600_000);
  assert.equal(ULTRA_SMS_TIMEOUT_MS, 8_000);
  assert.deepEqual(ULTRA_SMS_HOST_LIMIT, { max: 60, windowMs: 3_600_000 });
  assert.ok(Object.isFrozen(ULTRA_SMS_HOST_LIMIT));
  assert.equal(
    ULTRA_SMS_TEST_TEXT,
    'GEVC Ultra test: this phone receives help network alerts.',
  );
  assert.equal(ULTRA_SMS_NO_RELAY, 'NO SMS RELAY');
  assert.equal(ULTRA_SMS_SENDING, 'SENDING');
  assert.equal(ULTRA_SMS_UNKNOWN, 'SMS: NOT KNOWN SINCE RESTART');
  assert.equal(ULTRA_SMS_NO_NUMBER, 'NO SMS: SAVE MY # FIRST');
  // Every word fits the 40 characters an inbox row's SMS line keeps.
  for (const word of [
    ULTRA_SMS_NO_RELAY,
    ULTRA_SMS_SENDING,
    ULTRA_SMS_UNKNOWN,
    ULTRA_SMS_NO_NUMBER,
  ])
    assert.ok(word.length <= 40, word);
  assert.equal(ULTRA_SMS_TWILIO_HOST, 'api.twilio.com');
  assert.match(ULTRA_SMS_USER_AGENT, /^gods-eye-view-ultra\//);
});

test('ultraSmsRelayConfig names Twilio, the gateway or nothing, and never a secret', () => {
  assert.deepEqual(ultraSmsRelayConfig(TWILIO), {
    provider: 'twilio',
    host: 'api.twilio.com',
    configured: true,
  });
  assert.deepEqual(ultraSmsRelayConfig(GENERIC), {
    provider: 'generic',
    host: 'sms.example.net',
    configured: true,
  });
  // Twilio wins when both recipes are present.
  assert.equal(
    ultraSmsRelayConfig({ ...TWILIO, ...GENERIC }).provider,
    'twilio',
  );
  // Whitespace around a value is tolerated; the port stays in the host.
  assert.equal(
    ultraSmsRelayConfig({
      TWILIO_ACCOUNT_SID: ' ' + SID + ' ',
      TWILIO_AUTH_TOKEN: AUTH + '\n',
      TWILIO_FROM_NUMBER: ' +1 (506) 555-0199 ',
    }).provider,
    'twilio',
  );
  assert.equal(
    ultraSmsRelayConfig({
      ULTRA_SMS_RELAY_URL: 'http://100.64.1.2:8080/sms',
      ULTRA_SMS_RELAY_TOKEN: GATEWAY_TOKEN,
    }).host,
    '100.64.1.2:8080',
  );
  // Missing or unusable pieces mean not configured.
  const none = { provider: '', host: '', configured: false };
  for (const env of [
    {},
    null,
    undefined,
    'text',
    { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: AUTH },
    { TWILIO_ACCOUNT_SID: SID, TWILIO_FROM_NUMBER: FROM },
    { TWILIO_AUTH_TOKEN: AUTH, TWILIO_FROM_NUMBER: FROM },
    { ...TWILIO, TWILIO_FROM_NUMBER: '5065550199' },
    { ...TWILIO, TWILIO_FROM_NUMBER: '911' },
    { ...TWILIO, TWILIO_ACCOUNT_SID: 'AC/../x' },
    { ...TWILIO, TWILIO_ACCOUNT_SID: '' },
    { ...TWILIO, TWILIO_AUTH_TOKEN: 'has space' },
    { ...TWILIO, TWILIO_AUTH_TOKEN: '' },
    { ULTRA_SMS_RELAY_URL: GATEWAY_URL },
    { ULTRA_SMS_RELAY_TOKEN: GATEWAY_TOKEN },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: 'http://sms.example.net/send' },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: 'http://192.168.1.5/send' },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: 'http://127.0.0.1/send' },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: 'http://10.0.0.7/send' },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: 'http://100.63.0.1/send' },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: 'http://100.128.0.1/send' },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: 'ftp://sms.example.net/send' },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: 'https://user:pw@sms.example.net/' },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: 'not a url' },
    { ...GENERIC, ULTRA_SMS_RELAY_URL: '' },
    { ...GENERIC, ULTRA_SMS_RELAY_TOKEN: 'two words' },
    { ...GENERIC, ULTRA_SMS_RELAY_TOKEN: '' },
    { TWILIO_ACCOUNT_SID: 7, TWILIO_AUTH_TOKEN: 8, TWILIO_FROM_NUMBER: 9 },
  ]) {
    assert.deepEqual(ultraSmsRelayConfig(env), none, JSON.stringify(env));
  }
  // http to a tailnet literal is the one plain-http case allowed.
  assert.equal(
    ultraSmsRelayConfig({
      ULTRA_SMS_RELAY_URL: 'http://100.64.1.2/sms',
      ULTRA_SMS_RELAY_TOKEN: GATEWAY_TOKEN,
    }).configured,
    true,
  );
  assert.equal(
    ultraSmsRelayConfig({
      ULTRA_SMS_RELAY_URL: 'http://100.127.255.254/sms',
      ULTRA_SMS_RELAY_TOKEN: GATEWAY_TOKEN,
    }).configured,
    true,
  );
  // No configured value ever appears in the config.
  for (const env of [TWILIO, GENERIC, { ...TWILIO, ...GENERIC }]) {
    const text = JSON.stringify(ultraSmsRelayConfig(env));
    for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
  }
});

test('ultraSmsRelayPublic carries a provider word, a flag and a host and nothing else', () => {
  assert.deepEqual(ultraSmsRelayPublic(ultraSmsRelayConfig(TWILIO)), {
    provider: 'twilio',
    configured: true,
    host: 'api.twilio.com',
  });
  assert.deepEqual(ultraSmsRelayPublic(ultraSmsRelayConfig({})), {
    provider: '',
    configured: false,
    host: '',
  });
  const leaky = ultraSmsRelayPublic({
    provider: 'generic',
    configured: true,
    host: 'sms.example.net',
    token: GATEWAY_TOKEN,
    sid: SID,
    url: GATEWAY_URL,
  });
  assert.deepEqual(Object.keys(leaky).sort(), [
    'configured',
    'host',
    'provider',
  ]);
  for (const secret of SECRETS)
    assert.ok(!JSON.stringify(leaky).includes(secret));
  assert.deepEqual(ultraSmsRelayPublic({ provider: 'carrier', host: 7 }), {
    provider: '',
    configured: false,
    host: '',
  });
  assert.deepEqual(ultraSmsRelayPublic(null), {
    provider: '',
    configured: false,
    host: '',
  });
});

test('ultraSmsRelayBody is the capitalised name, NEEDS HELP and the plea, cut at 320', () => {
  assert.equal(
    ultraSmsRelayBody('Jeff (Van 7)', PLEA),
    'JEFF (VAN 7) NEEDS HELP: Please HELP you are close by, to 10 Example St, Saint John, New Brunswick (45.2744, -66.0622) of victim in progress, fire thank you.',
  );
  const long = ultraSmsRelayBody('Jeff', 'x'.repeat(600));
  assert.equal(long.length, 320);
  assert.ok(long.startsWith('JEFF NEEDS HELP: xxx'));
  assert.equal(ultraSmsRelayBody('Jeff', PLEA).length <= 320, true);
  // The name is cleaned and cut at 60 before it is capitalised.
  assert.ok(
    ultraSmsRelayBody('a'.repeat(80), 'plea').startsWith(
      'A'.repeat(60) + ' NEEDS HELP: plea',
    ),
  );
  assert.equal(
    ultraSmsRelayBody('Sam\u0000 \u0007Jones', 'plea'),
    'SAM JONES NEEDS HELP: plea',
  );
  // A peer's name is one line, and cannot turn the text after it around.
  assert.equal(
    ultraSmsRelayBody('Sam\n\nIGNORE THIS ALERT‮', 'plea'),
    'SAM IGNORE THIS ALERT NEEDS HELP: plea',
  );
  assert.equal(ultraSmsRelayBody('', 'plea'), 'SOMEONE NEEDS HELP: plea');
  assert.equal(ultraSmsRelayBody(null, 'plea'), 'SOMEONE NEEDS HELP: plea');
  assert.equal(ultraSmsRelayBody('Sam', 'a\u0001b'), 'SAM NEEDS HELP: ab');
  assert.equal(ultraSmsRelayBody('Sam', ''), 'SAM NEEDS HELP: ');
  assert.equal(ultraSmsRelayBody('Sam', { text: 'x' }), 'SAM NEEDS HELP: ');
});

test('ultraSmsRelayRequest builds the Twilio form POST under Basic auth', () => {
  const config = ultraSmsRelayConfig(TWILIO);
  const request = ultraSmsRelayRequest(config, TWILIO, {
    to: OWNER,
    body: 'VAN 7 NEEDS HELP: ' + PLEA,
  });
  assert.ok(request);
  assert.equal(
    request.url,
    `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
  );
  assert.equal(new URL(request.url).host, 'api.twilio.com');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.equal(request.init.signal.aborted, false);
  assert.equal(
    request.init.headers.Authorization,
    'Basic ' + Buffer.from(`${SID}:${AUTH}`).toString('base64'),
  );
  assert.equal(
    request.init.headers['Content-Type'],
    'application/x-www-form-urlencoded',
  );
  assert.equal(request.init.headers['User-Agent'], ULTRA_SMS_USER_AGENT);
  assert.equal('Cookie' in request.init.headers, false);
  const form = new URLSearchParams(request.init.body);
  assert.deepEqual([...form.keys()].sort(), ['Body', 'From', 'To']);
  assert.equal(form.get('To'), OWNER);
  assert.equal(form.get('From'), FROM);
  assert.equal(form.get('Body'), 'VAN 7 NEEDS HELP: ' + PLEA);
  // A loose number is normalised; the body is cleaned and capped.
  const loose = ultraSmsRelayRequest(config, TWILIO, {
    to: '+1 (506) 555-0100',
    body: 'a\u0000' + 'x'.repeat(600),
  });
  assert.equal(new URLSearchParams(loose.init.body).get('To'), OWNER);
  assert.equal(new URLSearchParams(loose.init.body).get('Body').length, 320);
});

test('ultraSmsRelayRequest builds the generic JSON POST under a bearer token', () => {
  const config = ultraSmsRelayConfig(GENERIC);
  const request = ultraSmsRelayRequest(config, GENERIC, {
    to: OWNER,
    body: 'SAM NEEDS HELP: ' + PLEA,
  });
  assert.ok(request);
  assert.equal(request.url, GATEWAY_URL);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.equal(request.init.headers.Authorization, 'Bearer ' + GATEWAY_TOKEN);
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.init.body), {
    to: OWNER,
    body: 'SAM NEEDS HELP: ' + PLEA,
  });
  // The tailnet http form keeps its URL as given.
  const tailnet = {
    ULTRA_SMS_RELAY_URL: 'http://100.64.1.2:8080/sms',
    ULTRA_SMS_RELAY_TOKEN: GATEWAY_TOKEN,
  };
  assert.equal(
    ultraSmsRelayRequest(ultraSmsRelayConfig(tailnet), tailnet, {
      to: OWNER,
      body: 'x',
    }).url,
    'http://100.64.1.2:8080/sms',
  );
  // With both recipes in the environment Twilio is the one used.
  const both = { ...TWILIO, ...GENERIC };
  assert.equal(
    new URL(
      ultraSmsRelayRequest(ultraSmsRelayConfig(both), both, {
        to: OWNER,
        body: 'x',
      }).url,
    ).host,
    'api.twilio.com',
  );
  // A config naming a provider the environment no longer has builds nothing.
  assert.equal(
    ultraSmsRelayRequest({ provider: 'twilio', configured: true }, GENERIC, {
      to: OWNER,
      body: 'x',
    }),
    null,
  );
  // A null config falls back to whatever the environment configures.
  assert.ok(ultraSmsRelayRequest(null, GENERIC, { to: OWNER, body: 'x' }));
});

test('ultraSmsRelayRequest builds nothing for a short code, a bad number, an empty body or no relay', () => {
  const config = ultraSmsRelayConfig(TWILIO);
  for (const to of [
    '911',
    '112',
    '5065550100',
    '+0123',
    'call me',
    '',
    null,
    undefined,
    '+15065550100?x=1',
  ]) {
    assert.equal(
      ultraSmsRelayRequest(config, TWILIO, { to, body: 'x' }),
      null,
      String(to),
    );
  }
  assert.equal(
    ultraSmsRelayRequest(config, TWILIO, { to: OWNER, body: '' }),
    null,
  );
  assert.equal(
    ultraSmsRelayRequest(config, TWILIO, { to: OWNER, body: '\u0000 ' }),
    null,
  );
  assert.equal(ultraSmsRelayRequest(config, TWILIO, {}), null);
  assert.equal(ultraSmsRelayRequest(config, TWILIO), null);
  assert.equal(
    ultraSmsRelayRequest(config, {}, { to: OWNER, body: 'x' }),
    null,
  );
  assert.equal(
    ultraSmsRelayRequest(
      ultraSmsRelayConfig({}),
      {},
      {
        to: OWNER,
        body: 'x',
      },
    ),
    null,
  );
});

test('ultraSmsRelayAllowed enforces the per-key cooldown and the test spacing', () => {
  const ledger = newUltraSmsLedger();
  assert.deepEqual(
    ultraSmsRelayAllowed(ledger, {
      kind: 'peer',
      key: 'n-0000000000000001',
      host: 'api.twilio.com',
      now: NOW,
    }),
    { ok: true, reason: '' },
  );
  assert.deepEqual(
    ultraSmsRelayAllowed(ledger, {
      kind: 'peer',
      key: 'n-0000000000000001',
      host: 'api.twilio.com',
      now: NOW + ULTRA_SMS_RENOTIFY_MS - 1,
    }),
    { ok: false, reason: 'cooldown' },
  );
  // Another key is not held back by the first.
  assert.equal(
    ultraSmsRelayAllowed(ledger, {
      kind: 'peer',
      key: 'n-0000000000000002',
      host: 'api.twilio.com',
      now: NOW + 1000,
    }).ok,
    true,
  );
  assert.equal(
    ultraSmsRelayAllowed(ledger, {
      kind: 'own',
      key: 'own:security-van:+15065550100',
      host: 'api.twilio.com',
      now: NOW + 1000,
    }).ok,
    true,
  );
  assert.equal(
    ultraSmsRelayAllowed(ledger, {
      kind: 'own',
      key: 'own:security-van:+15065550100',
      host: 'api.twilio.com',
      now: NOW + 2000,
    }).reason,
    'cooldown',
  );
  // Ten minutes later the first key may send again.
  assert.deepEqual(
    ultraSmsRelayAllowed(ledger, {
      kind: 'peer',
      key: 'n-0000000000000001',
      host: 'api.twilio.com',
      now: NOW + ULTRA_SMS_RENOTIFY_MS,
    }),
    { ok: true, reason: '' },
  );
  // A test is spaced by its own rule and does not touch the entry keys.
  assert.deepEqual(
    ultraSmsRelayAllowed(ledger, {
      kind: 'test',
      host: 'api.twilio.com',
      now: NOW + 3000,
    }),
    { ok: true, reason: '' },
  );
  assert.deepEqual(
    ultraSmsRelayAllowed(ledger, {
      kind: 'test',
      host: 'api.twilio.com',
      now: NOW + 3000 + ULTRA_SMS_TEST_MS - 1,
    }),
    { ok: false, reason: 'test' },
  );
  assert.equal(ledger.lastTestAt, NOW + 3000);
  assert.equal(
    ultraSmsRelayAllowed(ledger, {
      kind: 'test',
      host: 'api.twilio.com',
      now: NOW + 3000 + ULTRA_SMS_TEST_MS,
    }).ok,
    true,
  );
  assert.equal(ledger.byEntry.has(''), false);
  // A refusal records nothing: the cooldown clock is the last accepted send.
  assert.equal(
    ledger.byEntry.get('n-0000000000000001'),
    NOW + ULTRA_SMS_RENOTIFY_MS,
  );
  assert.equal(ultraSmsSentToday(ledger, NOW + 4000), 6);
  // A bare object works as a ledger and is filled in place.
  const bare = {};
  assert.equal(
    ultraSmsRelayAllowed(bare, { kind: 'peer', key: 'k', host: 'h', now: NOW })
      .ok,
    true,
  );
  assert.ok(bare.byEntry instanceof Map);
  assert.ok(bare.byHost instanceof Map);
  assert.equal(bare.day.count, 1);
  assert.equal(bare.lastTestAt, null);
});

test('ultraSmsRelayAllowed caps a day at 50 and resets when the calendar day turns', () => {
  const ledger = newUltraSmsLedger();
  // Peer notices stop at the cap less the owner's reserve...
  const peerCeiling = ULTRA_SMS_DAILY_LIMIT - ULTRA_SMS_OWN_RESERVE;
  for (let i = 0; i < peerCeiling; i += 1) {
    assert.equal(
      ultraSmsRelayAllowed(ledger, {
        kind: 'peer',
        key: 'n-' + String(i).padStart(16, '0'),
        host: 'api.twilio.com',
        now: NOW + i * 1000,
      }).ok,
      true,
      `send ${i}`,
    );
  }
  assert.equal(ultraSmsSentToday(ledger, NOW + 60_000), peerCeiling);
  assert.deepEqual(
    ultraSmsRelayAllowed(ledger, {
      kind: 'peer',
      key: 'n-00000000000000ff',
      host: 'api.twilio.com',
      now: NOW + 60_000,
    }),
    { ok: false, reason: 'daily' },
  );
  // ...but the owner's own call for help still goes out, all the way to the
  // full cap: a busy home list must never silence their own helpers.
  for (let i = peerCeiling; i < ULTRA_SMS_DAILY_LIMIT; i += 1) {
    assert.equal(
      ultraSmsRelayAllowed(ledger, {
        kind: 'own',
        key: `own:${i}:+15065550100`,
        host: 'api.twilio.com',
        now: NOW + i * 1000,
      }).ok,
      true,
      `own send ${i}`,
    );
  }
  assert.equal(ultraSmsSentToday(ledger, NOW + 60_000), ULTRA_SMS_DAILY_LIMIT);
  assert.deepEqual(
    ultraSmsRelayAllowed(ledger, {
      kind: 'own',
      key: 'own:last:+15065550100',
      host: 'api.twilio.com',
      now: NOW + 60_000,
    }),
    { ok: false, reason: 'daily' },
  );
  // A test counts as a message too and is refused by the same cap.
  assert.equal(
    ultraSmsRelayAllowed(ledger, {
      kind: 'test',
      host: 'api.twilio.com',
      now: NOW + 61_000,
    }).reason,
    'daily',
  );
  assert.equal(ledger.lastTestAt, null);
  // The next calendar day starts from zero; the cooldown keys still apply.
  const tomorrow = NOW + 24 * 3_600_000;
  assert.equal(ultraSmsSentToday(ledger, tomorrow), 0);
  assert.deepEqual(
    ultraSmsRelayAllowed(ledger, {
      kind: 'peer',
      key: 'n-00000000000000ff',
      host: 'api.twilio.com',
      now: tomorrow,
    }),
    { ok: true, reason: '' },
  );
  assert.equal(ultraSmsSentToday(ledger, tomorrow), 1);
  assert.equal(ledger.day.count, 1);
});

test('a full helper list is texted after peers spend their share of the day', () => {
  const ledger = newUltraSmsLedger();
  // A busy home list sends peer notices until the day refuses one…
  let peers = 0;
  for (;;) {
    const booked = ultraSmsRelayAllowed(ledger, {
      kind: 'peer',
      key: 'n-' + String(peers).padStart(16, '0'),
      host: 'api.twilio.com',
      now: NOW + peers * 1000,
    });
    if (!booked.ok) {
      assert.equal(booked.reason, 'daily');
      break;
    }
    peers += 1;
    assert.ok(peers <= ULTRA_SMS_DAILY_LIMIT, 'the peer ceiling never bit');
  }
  // …and then the owner presses SEND HELP with every PREDEFINED HELP # saved:
  // each one is texted.
  const refused = [];
  for (let i = 0; i < ULTRA_HELP_CONTACT_LIMIT; i += 1) {
    const booked = ultraSmsRelayAllowed(ledger, {
      kind: 'own',
      key: `${NOW}:+1506555${String(i).padStart(4, '0')}`,
      host: 'api.twilio.com',
      now: NOW + 120_000 + i,
    });
    if (!booked.ok) refused.push(`${i}:${booked.reason}`);
  }
  assert.deepEqual(refused, []);
  assert.equal(
    ultraSmsSentToday(ledger, NOW + 130_000),
    peers + ULTRA_HELP_CONTACT_LIMIT,
  );
});

test('ultraSmsRelayAllowed caps one provider host at 60 an hour', () => {
  // The daily cap is lower than the hourly host cap, so the only way to
  // reach 61 in an hour is across midnight: thirty sends before it and
  // thirty-one after, all inside one hour. They are the owner's own, which
  // may run to the full daily cap (a peer's share stops at thirty).
  const midnight = new Date(2026, 8, 29, 0, 0, 0).getTime();
  const ledger = newUltraSmsLedger();
  let n = 0;
  const send = (now, host = 'api.twilio.com') =>
    ultraSmsRelayAllowed(ledger, {
      kind: 'own',
      key: 'n-' + String((n += 1)).padStart(16, '0'),
      host,
      now,
    });
  for (let i = 0; i < 30; i += 1)
    assert.equal(send(midnight - 20 * 60_000 + i * 1000).ok, true, `pre ${i}`);
  for (let i = 0; i < 30; i += 1)
    assert.equal(send(midnight + 5 * 60_000 + i * 1000).ok, true, `post ${i}`);
  assert.deepEqual(send(midnight + 10 * 60_000), {
    ok: false,
    reason: 'host',
  });
  // Another host has its own hour; the first host frees up as hits age out.
  assert.equal(send(midnight + 10 * 60_000, 'sms.example.net').ok, true);
  assert.equal(send(midnight + 45 * 60_000).ok, true);
  assert.equal(ledger.byHost.get('api.twilio.com').length, 31);
  // The host key is case-insensitive.
  assert.equal(ledger.byHost.has('API.TWILIO.COM'), false);
  assert.equal(send(midnight + 41 * 60_000, 'API.TWILIO.COM').ok, true);
  assert.equal(ledger.byHost.get('api.twilio.com').length, 32);
});

test('peer notices across midnight still leave the owner their reserve of the host’s hour', () => {
  // A busy home list texts every thirty seconds from 23:30 to 00:15: thirty
  // before midnight, when the day refuses the rest, and more after it, when
  // the day starts again but the host's hour does not.
  const midnight = new Date(2026, 8, 29, 0, 0, 0).getTime();
  const ledger = newUltraSmsLedger();
  const refused = {};
  let peers = 0;
  let i = 0;
  for (
    let at = midnight - 30 * 60_000;
    at <= midnight + 15 * 60_000;
    at += 30_000
  ) {
    const booked = ultraSmsRelayAllowed(ledger, {
      kind: 'peer',
      key: 'n-' + String((i += 1)).padStart(16, '0'),
      host: 'api.twilio.com',
      now: at,
    });
    if (booked.ok) peers += 1;
    else refused[booked.reason] = (refused[booked.reason] || 0) + 1;
  }
  assert.equal(peers, ULTRA_SMS_HOST_LIMIT.max - ULTRA_SMS_OWN_RESERVE);
  assert.ok(refused.daily > 0 && refused.host > 0, JSON.stringify(refused));
  // At 00:15 the owner presses SEND HELP with every PREDEFINED HELP # saved.
  const own = [];
  for (let n = 0; n < ULTRA_HELP_CONTACT_LIMIT; n += 1) {
    const booked = ultraSmsRelayAllowed(ledger, {
      kind: 'own',
      key: `${midnight}:+1506555${String(n).padStart(4, '0')}`,
      host: 'api.twilio.com',
      now: midnight + 15 * 60_000 + n,
    });
    if (!booked.ok) own.push(`${n}:${booked.reason}`);
  }
  assert.deepEqual(own, [], 'every saved helper is texted');
});

test('ultraSmsRelayAllowed keeps the key map bounded', () => {
  const ledger = newUltraSmsLedger();
  const day = new Date(2026, 8, 1, 12, 0, 0).getTime();
  // Spread over days so neither the daily nor the host cap interferes.
  const perDay = ULTRA_SMS_DAILY_LIMIT - ULTRA_SMS_OWN_RESERVE;
  for (let i = 0; i < 1100; i += 1) {
    const now =
      day + Math.floor(i / perDay) * 24 * 3_600_000 + (i % perDay) * 61_000;
    assert.equal(
      ultraSmsRelayAllowed(ledger, {
        kind: 'peer',
        key: 'k' + i,
        host: 'h',
        now,
      }).ok,
      true,
      `send ${i}`,
    );
  }
  assert.equal(ledger.byEntry.size, 1000);
  assert.equal(ledger.byEntry.has('k0'), false);
  assert.equal(ledger.byEntry.has('k99'), false);
  assert.equal(ledger.byEntry.has('k100'), true);
  assert.equal(ledger.byEntry.has('k1099'), true);
});

test('ultraSmsRelayForget shortens the cooldown of a send that did not go out', () => {
  const ledger = newUltraSmsLedger();
  const booking = {
    kind: 'own',
    key: 'press:+15065550100',
    host: 'h',
    now: NOW,
  };
  assert.equal(ULTRA_SMS_RETRY_MS, 60_000);
  assert.equal(ultraSmsRelayAllowed(ledger, booking).ok, true);
  // Refused inside ten minutes while that send stands…
  assert.equal(
    ultraSmsRelayAllowed(ledger, { ...booking, now: NOW + 1000 }).reason,
    'cooldown',
  );
  // …and, once it failed, allowed again a minute after it — not at once, so a
  // burst of presses during an outage cannot spend the day in seconds.
  ultraSmsRelayForget(ledger, { key: booking.key, at: NOW });
  assert.equal(
    ultraSmsRelayAllowed(ledger, { ...booking, now: NOW + 2000 }).reason,
    'cooldown',
  );
  assert.equal(
    ultraSmsRelayAllowed(ledger, { ...booking, now: NOW + 60_000 }).ok,
    true,
  );
  // Only the stamp that send wrote is touched: a newer send keeps its own.
  ultraSmsRelayForget(ledger, { key: booking.key, at: NOW });
  assert.equal(
    ultraSmsRelayAllowed(ledger, { ...booking, now: NOW + 61_000 }).reason,
    'cooldown',
  );
  // The failed send gave back its place in the day and the host; the one
  // after it still holds its own.
  assert.equal(ultraSmsSentToday(ledger, NOW + 61_000), 1);
  assert.deepEqual(ledger.byHost.get('h'), [NOW + 60_000]);
  // A send that may have gone out after all (a timeout) keeps its place.
  const other = { ...booking, key: 'press:+15065550101', now: NOW + 62_000 };
  assert.equal(ultraSmsRelayAllowed(ledger, other).ok, true);
  ultraSmsRelayForget(ledger, { key: other.key, at: other.now, spent: true });
  assert.equal(ultraSmsSentToday(ledger, NOW + 62_000), 2);
  assert.deepEqual(ledger.byHost.get('h'), [NOW + 60_000, NOW + 62_000]);
  // Junk in, nothing changed.
  ultraSmsRelayForget(null, { key: booking.key, at: 'x' });
  ultraSmsRelayForget(ledger);
  assert.equal(
    ultraSmsRelayAllowed(ledger, { ...booking, now: NOW + 63_000 }).reason,
    'cooldown',
  );
});

test('an outage cannot spend the day: twenty helpers, presses every twenty seconds', () => {
  const ledger = newUltraSmsLedger();
  const numbers = Array.from(
    { length: 20 },
    (_, i) => `+1506555${String(i).padStart(4, '0')}`,
  );
  let requests = 0;
  // Five minutes of presses while every send fails at the provider.
  for (let t = 0; t <= 300_000; t += 20_000) {
    for (const number of numbers) {
      const at = NOW + t;
      const key = `call:${number}`;
      const booked = ultraSmsRelayAllowed(ledger, {
        kind: 'own',
        key,
        host: 'h',
        now: at,
      });
      if (!booked.ok) continue;
      requests += 1;
      ultraSmsRelayForget(ledger, { key, at });
    }
  }
  // Each number is tried once a minute, not on every press…
  assert.equal(requests, 20 * 6);
  // …and none of it counts: once the relay is back, every helper is texted.
  assert.equal(ultraSmsSentToday(ledger, NOW + 300_000), 0);
  const back = NOW + 360_000;
  assert.ok(
    numbers.every(
      (number) =>
        ultraSmsRelayAllowed(ledger, {
          kind: 'own',
          key: `call:${number}`,
          host: 'h',
          now: back,
        }).ok,
    ),
  );
});

test('ultraOwnSmsOutcome says what happened to each number, never "already texted" for one that was not', () => {
  const A = '+15065550100';
  const B = '+15065550101';
  const C = '+15065550102';
  const call = (over = {}) => ({
    numbers: [A, B, C],
    sent: new Set(),
    pending: new Set(),
    failed: new Map(),
    limited: new Map(),
    lastSentAt: NOW,
    ...over,
  });
  const at = new Date(NOW);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  // Nothing tried yet: the caller says SENDING or NO SMS RELAY.
  assert.equal(ultraOwnSmsOutcome(call()), '');
  assert.equal(ultraOwnSmsOutcome(), '');
  // Any text on its way.
  assert.equal(
    ultraOwnSmsOutcome(call({ pending: new Set([B]), sent: new Set([A]) })),
    ULTRA_SMS_SENDING,
  );
  // Every number texted.
  assert.equal(
    ultraOwnSmsOutcome(call({ sent: new Set([A, B, C]) })),
    `SMS SENT ${hhmm}`,
  );
  // Some texted, some not: counted, whatever order the answers came in.
  assert.equal(
    ultraOwnSmsOutcome(
      call({
        sent: new Set([A]),
        failed: new Map([[B, 'SMS FAILED: 21211']]),
        limited: new Map([[C, 'daily']]),
      }),
    ),
    'SMS SENT 1/3 · 2 NOT SENT',
  );
  // None texted: the failure, else the limit that held them.
  assert.equal(
    ultraOwnSmsOutcome(call({ failed: new Map([[A, 'SMS FAILED: timeout']]) })),
    'SMS FAILED: timeout',
  );
  assert.equal(
    ultraOwnSmsOutcome(call({ limited: new Map([[A, 'daily']]) })),
    'SMS NOT SENT: DAILY LIMIT',
  );
  assert.equal(
    ultraOwnSmsOutcome(call({ limited: new Map([[A, 'host']]) })),
    'SMS NOT SENT: HOURLY LIMIT',
  );
  // A number no longer saved does not count.
  assert.equal(
    ultraOwnSmsOutcome(
      call({ numbers: [A], sent: new Set([A]), failed: new Map([[B, 'x']]) }),
    ),
    `SMS SENT ${hhmm}`,
  );
});

test('ultraSmsFailureCode names a provider code or the HTTP status and never a sentence', () => {
  assert.equal(ultraSmsFailureCode(400, { code: 21211 }), '21211');
  assert.equal(ultraSmsFailureCode(400, { code: '21211' }), '21211');
  assert.equal(ultraSmsFailureCode(402, { code: 'quota' }), 'quota');
  assert.equal(ultraSmsFailureCode(401, {}), 'HTTP 401');
  assert.equal(ultraSmsFailureCode(401, null), 'HTTP 401');
  assert.equal(ultraSmsFailureCode('503', 'text'), 'HTTP 503');
  assert.equal(
    ultraSmsFailureCode(400, { code: 'The number +1506 is bad' }),
    'HTTP 400',
  );
  assert.equal(ultraSmsFailureCode(400, { code: -1 }), 'HTTP 400');
  assert.equal(ultraSmsFailureCode(400, { code: 1.5 }), 'HTTP 400');
  assert.equal(ultraSmsFailureCode(400, { code: 'x'.repeat(17) }), 'HTTP 400');
  assert.equal(ultraSmsFailureCode(400, { message: 'secret' }), 'HTTP 400');
  assert.equal(ultraSmsFailureCode(null, null), '');
  assert.equal(ultraSmsFailureCode(0, {}), '');
  assert.equal(ultraSmsFailureCode(undefined, { code: 30007 }), '30007');
});

test('ultraSmsOutcome paints SENT with the time or FAILED with a short code', () => {
  assert.equal(ultraSmsOutcome({ status: 201 }, NOW), 'SMS SENT ' + hhmm(NOW));
  assert.equal(ultraSmsOutcome({ status: 200 }, NOW), 'SMS SENT ' + hhmm(NOW));
  assert.equal(ultraSmsOutcome({ status: 204 }, NOW), 'SMS SENT ' + hhmm(NOW));
  assert.equal(
    ultraSmsOutcome({ status: 400, json: { code: 21211 } }, NOW),
    'SMS FAILED: 21211',
  );
  assert.equal(
    ultraSmsOutcome({ status: 400, code: 21211 }, NOW),
    'SMS FAILED: 21211',
  );
  assert.equal(ultraSmsOutcome({ status: 401 }, NOW), 'SMS FAILED: HTTP 401');
  assert.equal(ultraSmsOutcome({ status: 500 }, NOW), 'SMS FAILED: HTTP 500');
  assert.equal(ultraSmsOutcome({ status: 301 }, NOW), 'SMS FAILED: HTTP 301');
  const timeout = new DOMException('The operation was aborted', 'TimeoutError');
  assert.equal(ultraSmsOutcome({ error: timeout }, NOW), 'SMS FAILED: timeout');
  assert.equal(
    ultraSmsOutcome({ error: new Error('request timed out') }, NOW),
    'SMS FAILED: timeout',
  );
  assert.equal(
    ultraSmsOutcome({ error: new Error('ECONNREFUSED') }, NOW),
    'SMS FAILED: unreachable',
  );
  assert.equal(
    ultraSmsOutcome({ error: 'boom' }, NOW),
    'SMS FAILED: unreachable',
  );
  assert.equal(ultraSmsOutcome({}, NOW), 'SMS FAILED: unreachable');
  assert.equal(ultraSmsOutcome(undefined, NOW), 'SMS FAILED: unreachable');
  // A provider message never reaches the word, and every word fits a row.
  const leaky = ultraSmsOutcome(
    { status: 400, json: { code: 21211, message: 'Sent to ' + OWNER } },
    NOW,
  );
  assert.ok(!leaky.includes(OWNER));
  for (const word of [
    ultraSmsOutcome({ status: 201 }, NOW),
    ultraSmsOutcome({ status: 400, json: { code: 'x'.repeat(16) } }, NOW),
    ultraSmsOutcome({ status: 503 }, NOW),
    ultraSmsOutcome({ error: timeout }, NOW),
  ]) {
    assert.ok(word.length <= 40, word);
  }
});

test('the module loads where Buffer is only a stub and reads nothing from the environment', () => {
  // The relay module is server-side, but importing it must touch neither
  // Buffer, crypto nor process.env until a function runs: a child process
  // with the Buffer global removed stands in for a bundle.
  const moduleUrl = new URL('./ultraSmsRelay.mjs', import.meta.url).href;
  const script = [
    'delete globalThis.Buffer;',
    `const m = await import(${JSON.stringify(moduleUrl)});`,
    "process.stdout.write(m.ultraSmsRelayBody('Sam', 'plea') + '|' + m.ultraSmsRelayConfig({}).provider);",
  ].join('\n');
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8', env: { ...process.env, TWILIO_ACCOUNT_SID: SID } },
  );
  assert.equal(out, 'SAM NEEDS HELP: plea|');
});
