import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KEY_SETUP_APPEND_HEADER,
  KEY_SETUP_KEYS,
  KEY_SETUP_UPDATE_LIMIT,
  KEY_SETUP_VALUE_LIMIT,
  commandCompletedSuccessfully,
  isKeySetupExternallyManaged,
  keySetupStatus,
  keySetupRequirement,
  knownKeySetupEnvVars,
  parseWindowsUserSid,
  upsertDotenvValues,
  validateKeySetupUpdates,
} from './keySetupCore.mjs';
import { ultraSmsRelayConfig } from '../server/shared/ultraSmsRelay.mjs';

test('provider requirements name the registry env vars and next step', () => {
  assert.equal(
    keySetupRequirement('cesium-ion'),
    'Needs CESIUM_ION_TOKEN — add it in Provider Settings',
  );
  assert.equal(keySetupRequirement('unknown'), '');
});

test('Road511 is a server-side POWER UP key for on-demand US camera lookups', () => {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === 'road511');
  assert.ok(entry, 'the ROAD511 entry is registered');
  assert.equal(entry.title, 'ROAD511');
  assert.deepEqual([...entry.envVars], ['ROAD511_API_KEY']);
  assert.equal(entry.tier, 'metered');
  assert.equal(entry.getUrl, 'https://road511.com');
  assert.equal(Boolean(entry.clientExposed), false, 'the key never reaches the browser bundle');
  assert.equal(Boolean(entry.hidden), false, 'the key has its own row in the panel');
  assert.equal(
    keySetupRequirement('road511'),
    'Needs ROAD511_API_KEY — add it in Provider Settings',
  );
  assert.ok(knownKeySetupEnvVars().has('ROAD511_API_KEY'));
  const status = keySetupStatus({ ROAD511_API_KEY: 'road511-fixture-key' });
  const road511 = status.keys.find((key) => key.id === 'road511');
  assert.equal(road511.set, true);
  assert.equal(road511.clientExposed, false);
  assert.ok(!JSON.stringify(status).includes('road511-fixture-key'), 'a value leaked into status');
});

test('the boot provenance snapshot survives in-process Vite config re-evaluation', () => {
  // server.restart() re-evaluates vite.config.js in the SAME process after a
  // panel save has already set its values live on process.env. A recomputed
  // snapshot would classify the panel's own keys as external (read-only) until
  // a full process relaunch, so the first evaluation's snapshot must win.
  const source = readFileSync(new URL('../server/standalone/key-setup.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /const PROVIDER_ENV_AT_BOOT\s*=\s*\(?globalThis\.__GEV_PROVIDER_ENV_AT_BOOT\s*\?\?=\s*Object\.freeze\(/,
  );
});

test('external ownership uses boot provenance even when store and shell values match', () => {
  assert.equal(isKeySetupExternallyManaged({
    effectiveValue: 'same-value',
    storedValue: 'same-value',
    wasExternalAtBoot: true,
  }), true, 'equal bytes cannot turn a shell/Keychain value into a file-owned value');
  assert.equal(isKeySetupExternallyManaged({
    effectiveValue: 'file-value',
    storedValue: 'file-value',
  }), false, 'a value loaded only from the owned store remains editable');
  assert.equal(isKeySetupExternallyManaged({
    effectiveValue: 'shell-value',
    storedValue: 'stale-file-value',
  }), true, 'a differing live value remains external');
  assert.equal(isKeySetupExternallyManaged({
    effectiveValue: '',
    storedValue: 'stale-file-value',
    wasExternalAtBoot: true,
  }), false, 'an absent live credential has no external owner');
});

test('the status payload reports presence without any credential material', () => {
  const env = {
    GOOGLE_MAPS_API_KEY: 'AIzaSyFakeFakeFakeFake1234',
    OPENSKY_CLIENT_ID: 'client-id-abcdef',
    // Secret missing: the OpenSky pair must read as NOT set.
  };
  const status = keySetupStatus(env);
  // Hidden keys stay out of the count; grouped alternatives (the LLM providers) count once.
  assert.equal(
    status.total,
    new Set(KEY_SETUP_KEYS.filter((key) => !key.hidden).map((key) => key.group || key.id)).size,
  );
  const google = status.keys.find((key) => key.id === 'google-maps');
  assert.equal(google.set, true);
  const opensky = status.keys.find((key) => key.id === 'opensky');
  assert.equal(opensky.set, false, 'half a credential pair is not configured');
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('AIzaSyFakeFakeFakeFake1234'), 'a value leaked into status');
  assert.ok(!serialized.includes('client-id-abcdef'), 'a value leaked into status');
  assert.ok(!serialized.includes('1234'), 'a credential suffix leaked into status');
  assert.ok(!serialized.includes('abcdef'), 'a credential suffix leaked into status');
  assert.ok(!serialized.includes('tails'), 'status must not expose a credential-tail field');
  assert.equal(status.setCount, 1);
});

test('whitespace-only env values do not count as configured', () => {
  const status = keySetupStatus({ OPENAI_API_KEY: '   ' });
  assert.equal(status.keys.find((key) => key.id === 'openai').set, false);
});

test('subprocess success requires a clean zero exit', () => {
  assert.equal(commandCompletedSuccessfully({ status: 0, signal: null }), true);
  assert.equal(commandCompletedSuccessfully({ status: 1, signal: null }), false);
  assert.equal(commandCompletedSuccessfully({ status: 0, signal: 'SIGTERM' }), false);
  assert.equal(commandCompletedSuccessfully({ status: 0, signal: null, error: new Error('spawn failed') }), false);
  assert.equal(commandCompletedSuccessfully(null), false);
});

test('Windows owner SID parsing reads only the structured user-SID CSV field', () => {
  const localUser = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  const entraUser = 'S-1-12-1-1111111111-2222222222-3333333333-4444444444';
  assert.equal(parseWindowsUserSid(`"WORKSTATION\\alice","${localUser}"\r\n`), localUser);
  assert.equal(parseWindowsUserSid(`"AzureAD\\alice","${entraUser}"`), entraUser);
  assert.equal(
    parseWindowsUserSid(`"${localUser}","S-1-5-32-545"`),
    null,
    'an SID-looking account name must never be mistaken for the token SID',
  );
  assert.equal(parseWindowsUserSid('"WORKSTATION\\alice","S-1-5-32-545"'), null, 'broad group SID refused');
  assert.equal(parseWindowsUserSid(`"WORKSTATION\\alice","${localUser}"\n"extra","${localUser}"`), null);
  assert.equal(parseWindowsUserSid(`"WORKSTATION\\alice","${localUser}`), null, 'unterminated CSV refused');
});

test('validation accepts every registry env var and only those', () => {
  const known = knownKeySetupEnvVars();
  // The SMS relay's number, gateway address and account id have a shape of
  // their own, as do Grok Bot's webhook and computer gateway URLs; every
  // other name takes a plain key.
  const shaped = {
    TWILIO_FROM_NUMBER: '+15065550100',
    ULTRA_SMS_RELAY_URL: 'https://relay.example/sms',
    TWILIO_ACCOUNT_SID: 'ACvalid123',
    GROK_BOT_WEBHOOK_URL: 'https://api2.cursor.sh/automations/webhook/aut_7Hq2',
    GROK_BOT_GATEWAY_URL: 'http://127.0.0.1:1340',
  };
  for (const name of known) {
    const value = shaped[name] || 'valid-value-123';
    const verdict = validateKeySetupUpdates({ [name]: value });
    assert.equal(verdict.ok, true, `${name} should validate`);
    assert.equal(verdict.updates[name], value);
  }
  assert.equal(validateKeySetupUpdates({ PATH: '/usr/bin' }).ok, false, 'PATH must be refused');
  assert.equal(validateKeySetupUpdates({ NODE_OPTIONS: '--x' }).ok, false, 'NODE_OPTIONS must be refused');
});

test('validation trims, and refuses empties, newlines, spaces, and oversize values', () => {
  const trimmed = validateKeySetupUpdates({ OPENAI_API_KEY: '  sk-abc123  ' });
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.updates.OPENAI_API_KEY, 'sk-abc123');
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: '' }).ok, false);
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: '   ' }).ok, false);
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: 'a\nb' }).ok, false, 'newline injection');
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: 'a b' }).ok, false, 'inner space');
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: 'kéy' }).ok, false, 'non-ASCII');
  assert.equal(
    validateKeySetupUpdates({ OPENAI_API_KEY: 'x'.repeat(KEY_SETUP_VALUE_LIMIT + 1) }).ok,
    false,
  );
  assert.equal(validateKeySetupUpdates(null).ok, false);
  assert.equal(validateKeySetupUpdates([]).ok, false);
  assert.equal(validateKeySetupUpdates({}).ok, false);
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: 42 }).ok, false);
});

test('upsert replaces the last active assignment in place', () => {
  const text = [
    '# comment stays',
    'OPENAI_API_KEY=old-one',
    'PORT=4173',
    'OPENAI_API_KEY=old-two',
    '',
  ].join('\n');
  const next = upsertDotenvValues(text, { OPENAI_API_KEY: 'new-key' });
  assert.equal(next, [
    '# comment stays',
    'OPENAI_API_KEY=old-one',
    'PORT=4173',
    'OPENAI_API_KEY=new-key',
    '',
  ].join('\n'));
});

test('upsert uncomments a commented assignment in place, keeping file shape', () => {
  const text = [
    '# Optional: NASA FIRMS live active fires.',
    '# FIRMS_MAP_KEY=',
    '',
    'PORT=4173',
  ].join('\n');
  const next = upsertDotenvValues(text, { FIRMS_MAP_KEY: 'firms-123' });
  assert.equal(next, [
    '# Optional: NASA FIRMS live active fires.',
    'FIRMS_MAP_KEY=firms-123',
    '',
    'PORT=4173',
  ].join('\n') + '\n');
});

test('upsert appends unknown keys under one shared header, once', () => {
  const first = upsertDotenvValues('PORT=4173\n', { OPENAI_API_KEY: 'sk-1' });
  assert.equal(first, [
    'PORT=4173',
    '',
    KEY_SETUP_APPEND_HEADER,
    'OPENAI_API_KEY=sk-1',
  ].join('\n') + '\n');
  const second = upsertDotenvValues(first, { FIRMS_MAP_KEY: 'f-2' });
  assert.equal(second, [
    'PORT=4173',
    '',
    KEY_SETUP_APPEND_HEADER,
    'OPENAI_API_KEY=sk-1',
    'FIRMS_MAP_KEY=f-2',
  ].join('\n') + '\n');
  assert.equal(second.split(KEY_SETUP_APPEND_HEADER).length, 2, 'header written once');
});

test('upsert births a well-formed file from nothing', () => {
  const next = upsertDotenvValues('', { GOOGLE_MAPS_API_KEY: 'AIza-x' });
  assert.equal(next, `${KEY_SETUP_APPEND_HEADER}\nGOOGLE_MAPS_API_KEY=AIza-x\n`);
});

test('upsert handles export-prefixed lines and never touches lookalike keys', () => {
  const text = [
    'export OPENAI_API_KEY=old',
    'NOT_OPENAI_API_KEY=keep-me',
    'OPENAI_API_KEY_MINI=keep-me-too',
  ].join('\n');
  const next = upsertDotenvValues(text, { OPENAI_API_KEY: 'new' });
  const lines = next.split('\n');
  assert.equal(lines[0], 'OPENAI_API_KEY=new');
  assert.equal(lines[1], 'NOT_OPENAI_API_KEY=keep-me');
  assert.equal(lines[2], 'OPENAI_API_KEY_MINI=keep-me-too');
});

test('upsert is idempotent for a repeated save', () => {
  const once = upsertDotenvValues('', { OPENAI_API_KEY: 'sk-1', FIRMS_MAP_KEY: 'f-1' });
  const twice = upsertDotenvValues(once, { OPENAI_API_KEY: 'sk-1', FIRMS_MAP_KEY: 'f-1' });
  assert.equal(once, twice);
});

test('a real .env.example round-trip: the curated file keeps its shape', () => {
  // A representative slice of the shipped .env.example.
  const example = [
    '# God\'s Eye View — environment variables',
    'GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here',
    '',
    '# Optional: OpenAI Realtime voice control. Do not prefix with VITE_.',
    'OPENAI_API_KEY=',
    'OPENAI_REALTIME_MODEL=gpt-realtime-2',
    '',
    '# TOMTOM_API_KEY=',
  ].join('\n');
  const next = upsertDotenvValues(example, {
    GOOGLE_MAPS_API_KEY: 'AIza-real',
    OPENAI_API_KEY: 'sk-real',
    TOMTOM_API_KEY: 'tt-real',
  });
  const lines = next.split('\n');
  assert.equal(lines[1], 'GOOGLE_MAPS_API_KEY=AIza-real');
  assert.equal(lines[4], 'OPENAI_API_KEY=sk-real');
  assert.equal(lines[5], 'OPENAI_REALTIME_MODEL=gpt-realtime-2', 'sibling key untouched');
  assert.equal(lines[7], 'TOMTOM_API_KEY=tt-real', 'commented key uncommented in place');
});

test('the admission gate refuses every non-local shape, one assertion per refusal', async () => {
  const { admitKeySetupRequest } = await import('./keySetupCore.mjs');
  const local = {
    method: 'POST',
    remoteAddress: '127.0.0.1',
    hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173',
    contentType: 'application/json',
    env: {},
  };
  assert.equal(admitKeySetupRequest(local).ok, true, 'the honest local request is admitted');
  assert.equal(admitKeySetupRequest({ ...local, method: 'GET', contentType: undefined }).ok, true, 'local GET needs no content type');
  assert.equal(admitKeySetupRequest({ ...local, origin: undefined }).ok, false, 'POST without Origin is refused');
  assert.equal(admitKeySetupRequest({ ...local, method: 'GET', origin: undefined, contentType: undefined }).ok, true, 'local GET may omit Origin');
  assert.equal(admitKeySetupRequest({ ...local, remoteAddress: '::ffff:127.0.0.1', hostHeader: '[::1]:4173', origin: 'http://[::1]:4173' }).ok, true, 'IPv6 loopback forms are local');

  // Tunnel/LAN sharing of any kind removes the surface outright — tunnel
  // traffic arrives FROM loopback, so no socket check can carry this boundary.
  assert.equal(admitKeySetupRequest({ ...local, env: { PINOKIO_SHARE_CLOUDFLARE: 'true' } }).ok, false, 'sharing disables the surface');
  assert.equal(admitKeySetupRequest({ ...local, env: { PINOKIO_SHARE_LOCAL: '1' } }).ok, false, 'LAN sharing disables the surface');
  // A LAN peer reaching a wide-bound server.
  assert.equal(admitKeySetupRequest({ ...local, remoteAddress: '192.168.1.20' }).ok, false, 'non-loopback socket refused');
  // Tunnel and DNS-rebinding traffic carries a foreign Host over a loopback socket.
  assert.equal(admitKeySetupRequest({ ...local, hostHeader: 'abc.trycloudflare.com' }).ok, false, 'foreign Host refused');
  assert.equal(admitKeySetupRequest({ ...local, hostHeader: 'workstation.local:4173' }).ok, false, 'non-localhost hostnames refused');
  assert.equal(admitKeySetupRequest({ ...local, hostHeader: '' }).ok, false, 'missing Host refused');
  assert.equal(admitKeySetupRequest({ ...local, hostHeader: '[::1].evil:4173' }).ok, false, 'malformed bracketed Host refused');
  // A hostile web page POSTing at localhost carries its own Origin.
  assert.equal(admitKeySetupRequest({ ...local, origin: 'https://evil.example' }).ok, false, 'cross-origin refused');
  assert.equal(admitKeySetupRequest({ ...local, origin: 'not a url' }).ok, false, 'unparseable Origin refused');
  assert.equal(admitKeySetupRequest({ ...local, origin: 'http://localhost:4174' }).ok, false, 'cross-port Origin refused');
  assert.equal(admitKeySetupRequest({ ...local, origin: 'https://localhost:4173' }).ok, false, 'cross-scheme Origin refused');
  assert.equal(admitKeySetupRequest({ ...local, origin: 'http://127.0.0.1:4173' }).ok, false, 'different loopback host Origin refused');
  // A simple-request POST (no JSON content type) is the CSRF write shape.
  const noJson = admitKeySetupRequest({ ...local, contentType: 'text/plain' });
  assert.equal(noJson.ok, false, 'non-JSON POST refused');
  assert.equal(noJson.status, 415);
});

test('a null value validates as a removal; an empty string still does not', () => {
  const removal = validateKeySetupUpdates({ OPENAI_API_KEY: null });
  assert.equal(removal.ok, true);
  assert.equal(removal.updates.OPENAI_API_KEY, null);
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: '' }).ok, false, 'empty is a mistake, not a removal');
  assert.equal(validateKeySetupUpdates({ PATH: null }).ok, false, 'removal is registry-bound too');
});

test('removal comments the assignment back out, returning the file to template shape', () => {
  const text = [
    '# Optional: OpenAI Realtime voice control.',
    'OPENAI_API_KEY=sk-live',
    'PORT=4173',
  ].join('\n');
  const next = upsertDotenvValues(text, { OPENAI_API_KEY: null });
  const lines = next.split('\n');
  assert.equal(lines[1], '# OPENAI_API_KEY=', 'active line commented out, not deleted');
  assert.equal(lines[2], 'PORT=4173', 'neighbors untouched');
  // Removing a key with no active assignment changes nothing.
  assert.equal(upsertDotenvValues(next, { FIRMS_MAP_KEY: null }), next);
  // The commented-out line is reusable: a later save uncomments it in place.
  const again = upsertDotenvValues(next, { OPENAI_API_KEY: 'sk-new' });
  assert.equal(again.split('\n')[1], 'OPENAI_API_KEY=sk-new');
});

test('the sharing gate treats a real PINOKIO_SHARE_VAR as sharing, but not the empty/sentinel normal state', async () => {
  const { admitKeySetupRequest } = await import('./keySetupCore.mjs');
  const base = {
    method: 'POST', remoteAddress: '127.0.0.1', hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173', contentType: 'application/json',
  };
  // The ordinary launch states: unset, empty, or the explicit disabled sentinel.
  assert.equal(admitKeySetupRequest({ ...base, env: {} }).ok, true, 'unset SHARE_VAR is normal');
  assert.equal(admitKeySetupRequest({ ...base, env: { PINOKIO_SHARE_VAR: '' } }).ok, true, 'empty SHARE_VAR is normal');
  assert.equal(admitKeySetupRequest({ ...base, env: { PINOKIO_SHARE_VAR: '__gev_sharing_disabled__' } }).ok, true, 'the disabled sentinel is normal');
  // A real tunnel var disables the surface.
  assert.equal(admitKeySetupRequest({ ...base, env: { PINOKIO_SHARE_VAR: 'MY_TUNNEL_TOKEN' } }).ok, false, 'a real share var is sharing');
});

test('the gate refuses proxied requests even from a loopback socket with local headers', async () => {
  const { admitKeySetupRequest } = await import('./keySetupCore.mjs');
  const base = {
    method: 'POST', remoteAddress: '127.0.0.1', hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173', contentType: 'application/json', env: {},
  };
  assert.equal(admitKeySetupRequest(base).ok, true, 'no proxy headers → admitted');
  for (const header of ['x-forwarded-for', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']) {
    assert.equal(
      admitKeySetupRequest({ ...base, proxyHeaders: { [header]: 'anything' } }).ok,
      false,
      `${header} present → refused`,
    );
  }
  // An empty forwarding header is not a proxy signal.
  assert.equal(admitKeySetupRequest({ ...base, proxyHeaders: { 'x-forwarded-for': '' } }).ok, true);
});

test('validation rejects dotenv metacharacters that would round-trip wrong', () => {
  for (const bad of ['abc#def', 'ab"cd', "ab'cd", 'ab$cd', 'ab\\cd', 'ab`cd']) {
    assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: bad }).ok, false, `${JSON.stringify(bad)} refused`);
  }
  // Real key alphabets still pass: base64url, JWT dots, hex, plus/slash.
  for (const good of ['sk-AbC0-9_x', 'eyJhbGc.eyJzdWI.QWxpY2U', 'a1b2c3d4e5f6', 'AB+cd/ef=']) {
    assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: good }).ok, true, `${good} accepted`);
  }
});

test('server Google key is offered in setup as its own slot', () => {
  const secret = 'server-key-fixture';
  assert.deepEqual(validateKeySetupUpdates({ GOOGLE_MAPS_SERVER_API_KEY: secret }), {
    ok: true, updates: { GOOGLE_MAPS_SERVER_API_KEY: secret },
  });
  assert.equal(validateKeySetupUpdates({ GOOGLE_MAPS_SERVER_API_KEY: null }).ok, true);
  const status = keySetupStatus({ GOOGLE_MAPS_SERVER_API_KEY: secret });
  const server = status.keys.find((key) => key.id === 'google-maps-server');
  assert.ok(server, 'the server key has a paste field of its own');
  assert.equal(server.set, true);
  assert.equal(server.title, 'GOOGLE MAPS — SERVER');
  assert.equal(status.keys.find((key) => key.id === 'google-maps').set, false, 'the browser key stays a separate slot');
  assert.equal(status.setCount, 1);
  assert.ok(!JSON.stringify(status).includes(secret));
});

test('the key registry keeps its invariants as entries are added', () => {
  const ids = new Set();
  const names = new Set();
  for (const entry of KEY_SETUP_KEYS) {
    assert.ok(entry.id && !ids.has(entry.id), `duplicate or missing id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.title && entry.unlocks, `${entry.id} needs a title and an unlocks line`);
    assert.match(entry.getUrl, /^https:\/\//, `${entry.id} getUrl must be https`);
    assert.ok(['free', 'metered'].includes(entry.tier), `${entry.id} tier`);
    assert.ok(Array.isArray(entry.envVars) && entry.envVars.length > 0, `${entry.id} envVars`);
    for (const name of entry.envVars) {
      assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${name} is not an env var name`);
      assert.ok(!names.has(name), `${name} appears under two entries`);
      names.add(name);
    }
  }
  assert.ok(names.size <= KEY_SETUP_UPDATE_LIMIT, 'one save must be able to carry every registry name');
});

test('a grouped provider satisfies the group with one key and never inflates the total', () => {
  const none = keySetupStatus({});
  const one = keySetupStatus({ XAI_API_KEY: 'x' });
  const two = keySetupStatus({ XAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'a' });
  assert.equal(one.total, none.total);
  assert.equal(one.setCount, none.setCount + 1);
  assert.equal(two.setCount, one.setCount, 'a second provider in the same group adds nothing');
  assert.equal(one.keys.find((key) => key.id === 'xai').group, 'llm');
});

test('the Ultra SMS relay is one POWER UP slot with two recipes, and every message costs money', () => {
  const twilio = KEY_SETUP_KEYS.find((candidate) => candidate.id === 'twilio-sms');
  const gateway = KEY_SETUP_KEYS.find((candidate) => candidate.id === 'ultra-sms-relay');
  assert.ok(twilio && gateway, 'both recipes are registered');
  assert.equal(twilio.group, 'ultra-sms');
  assert.equal(gateway.group, 'ultra-sms');
  assert.equal(twilio.title, 'SMS RELAY — TWILIO');
  assert.equal(gateway.title, 'SMS RELAY — YOUR OWN GATEWAY');
  assert.deepEqual([...twilio.envVars], ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']);
  assert.deepEqual([...gateway.envVars], ['ULTRA_SMS_RELAY_URL', 'ULTRA_SMS_RELAY_TOKEN']);
  assert.equal(twilio.tier, 'metered', 'Twilio bills per message');
  assert.equal(gateway.tier, 'free');
  assert.match(twilio.unlocks, /costs money per message/);
  assert.match(gateway.unlocks, /JSON \{ to, body \} with a bearer token/);
  assert.equal(Boolean(twilio.hidden) || Boolean(gateway.hidden), false, 'both rows show in the panel');
  assert.equal(Boolean(twilio.clientExposed) || Boolean(gateway.clientExposed), false, 'relay secrets never reach the browser bundle');

  // The group counts once, and either recipe satisfies it.
  const none = keySetupStatus({});
  const viaTwilio = keySetupStatus({ TWILIO_ACCOUNT_SID: 'ACfixture', TWILIO_AUTH_TOKEN: 'auth-fixture', TWILIO_FROM_NUMBER: '+15065550100' });
  const viaGateway = keySetupStatus({ ULTRA_SMS_RELAY_URL: 'https://relay.example/sms', ULTRA_SMS_RELAY_TOKEN: 'relay-fixture' });
  const both = keySetupStatus({ TWILIO_ACCOUNT_SID: 'ACfixture', TWILIO_AUTH_TOKEN: 'auth-fixture', TWILIO_FROM_NUMBER: '+15065550100', ULTRA_SMS_RELAY_URL: 'https://relay.example/sms', ULTRA_SMS_RELAY_TOKEN: 'relay-fixture' });
  assert.equal(viaTwilio.total, none.total, 'the group is one slot, not two');
  assert.equal(viaTwilio.setCount, none.setCount + 1);
  assert.equal(viaGateway.setCount, none.setCount + 1);
  assert.equal(both.setCount, viaTwilio.setCount, 'the second recipe adds nothing');
  assert.equal(keySetupStatus({ TWILIO_ACCOUNT_SID: 'ACfixture', TWILIO_AUTH_TOKEN: 'auth-fixture' }).keys.find((key) => key.id === 'twilio-sms').set, false, 'Twilio needs all three values');
  assert.equal(keySetupStatus({ ULTRA_SMS_RELAY_URL: 'https://relay.example/sms' }).keys.find((key) => key.id === 'ultra-sms-relay').set, false, 'the gateway needs its token');
  const flat = JSON.stringify(both);
  for (const secret of ['ACfixture', 'auth-fixture', '+15065550100', 'relay.example', 'relay-fixture']) {
    assert.ok(!flat.includes(secret), `${secret} leaked into status`);
  }
});

test('POWER UP refuses SMS relay values the relay would never use, and agrees with the relay on set', () => {
  const refused = [
    ['TWILIO_FROM_NUMBER', '15065550100', /country code/],
    ['TWILIO_FROM_NUMBER', '5065550100', /country code/],
    ['ULTRA_SMS_RELAY_URL', 'http://192.168.1.20:8080/sms', /https, or http to a 100\.64/],
    ['ULTRA_SMS_RELAY_URL', 'http://gateway.tail9.ts.net/sms', /https, or http to a 100\.64/],
    ['ULTRA_SMS_RELAY_URL', 'https://u:p@gw.example/sms', /no user:password/],
    ['TWILIO_ACCOUNT_SID', 'AC-123', /letters and digits only/],
    ['TWILIO_ACCOUNT_SID', 'AC_123', /letters and digits only/],
  ];
  for (const [name, value, error] of refused) {
    const verdict = validateKeySetupUpdates({ [name]: value });
    assert.equal(verdict.ok, false, `${name}=${value} must be refused`);
    assert.match(verdict.error, error);
    // The worked example in the number sentence is fixed text, not the value.
    assert.ok(!verdict.error.replace(/e\.g\. \S+/, '').includes(value), 'the refusal never echoes the value');
  }
  for (const [name, value] of [
    ['TWILIO_FROM_NUMBER', '+1-506-555-0100'],
    ['TWILIO_FROM_NUMBER', '+15065550100'],
    ['ULTRA_SMS_RELAY_URL', 'http://100.101.2.3:8080/sms'],
    ['ULTRA_SMS_RELAY_URL', 'https://gw.example/sms'],
  ]) {
    assert.equal(validateKeySetupUpdates({ [name]: value }).ok, true, `${name}=${value} is accepted`);
  }
  // Values set by hand in .env: the POWER UP count moves exactly when the
  // relay itself says it is configured.
  const twilio = { TWILIO_ACCOUNT_SID: 'ACfixture', TWILIO_AUTH_TOKEN: 'auth-fixture', TWILIO_FROM_NUMBER: '+15065550100' };
  const gateway = { ULTRA_SMS_RELAY_URL: 'https://gw.example/sms', ULTRA_SMS_RELAY_TOKEN: 'relay-fixture' };
  const samples = [
    {},
    twilio,
    gateway,
    { ...twilio, ...gateway },
    { ...twilio, TWILIO_FROM_NUMBER: '15065550100' },
    { ...twilio, TWILIO_FROM_NUMBER: '5065550100' },
    { ...twilio, TWILIO_FROM_NUMBER: '+1 (506) 555-0100' },
    { ...twilio, TWILIO_ACCOUNT_SID: 'AC-123' },
    { ...twilio, TWILIO_AUTH_TOKEN: 'a'.repeat(513) },
    { ...twilio, TWILIO_AUTH_TOKEN: 'two words' },
    { ...gateway, ULTRA_SMS_RELAY_URL: 'http://192.168.1.20:8080/sms' },
    { ...gateway, ULTRA_SMS_RELAY_URL: 'http://gateway.tail9.ts.net/sms' },
    { ...gateway, ULTRA_SMS_RELAY_URL: 'https://u:p@gw.example/sms' },
    { ...gateway, ULTRA_SMS_RELAY_URL: 'http://100.101.2.3:8080/sms' },
    { ...gateway, ULTRA_SMS_RELAY_URL: 'http://100.128.0.1/sms' },
    { ...gateway, ULTRA_SMS_RELAY_URL: `https://gw.example/${'p'.repeat(2048)}` },
    { ...gateway, ULTRA_SMS_RELAY_URL: 'not a url' },
    { ...twilio, TWILIO_FROM_NUMBER: '15065550100', ...gateway },
  ];
  const base = keySetupStatus({}).setCount;
  for (const env of samples) {
    const configured = ultraSmsRelayConfig(env).configured;
    assert.equal(keySetupStatus(env).setCount - base, configured ? 1 : 0, `POWER UP and the relay disagree on ${JSON.stringify(env).slice(0, 160)}`);
  }
  // The case the box showed as NOT CONFIGURED while POWER UP counted it.
  const bad = keySetupStatus({ ...twilio, TWILIO_FROM_NUMBER: '15065550100' });
  assert.equal(bad.keys.find((key) => key.id === 'twilio-sms').set, false);
  assert.ok(!JSON.stringify(bad).includes('15065550100'), 'a refused value is never echoed');
});

test('a relay value the relay refuses is not set, but still present, and the row names which one', () => {
  const twilio = { TWILIO_ACCOUNT_SID: 'ACfixture', TWILIO_AUTH_TOKEN: 'auth-fixture', TWILIO_FROM_NUMBER: '+15065550100' };
  const row = (env) => keySetupStatus(env).keys.find((key) => key.id === 'twilio-sms');
  // Saved before the rule existed: all three are there, the number cannot work.
  const old = row({ ...twilio, TWILIO_FROM_NUMBER: '15065550100' });
  assert.equal(old.set, false);
  assert.equal(old.present, true);
  assert.deepEqual(old.unusable, ['TWILIO_FROM_NUMBER']);
  assert.ok(!JSON.stringify(old).includes('15065550100'), 'a refused value is never echoed');
  const good = row(twilio);
  assert.equal(good.set, true);
  assert.equal(good.present, true);
  assert.deepEqual(good.unusable, []);
  // A row with a value missing is neither, as before this rule.
  const partial = row({ TWILIO_ACCOUNT_SID: 'ACfixture', TWILIO_AUTH_TOKEN: 'auth-fixture' });
  assert.equal(partial.set, false);
  assert.equal(partial.present, false);
  assert.deepEqual(partial.unusable, []);
  assert.equal(row({}).present, false);
});

test('the help network directory is registered but hidden: the Ultra box owns its form', () => {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === 'ultra-directory');
  assert.ok(entry, 'the directory entry is registered');
  assert.equal(entry.hidden, true);
  assert.equal(entry.title, 'HELP NETWORK DIRECTORY');
  assert.deepEqual([...entry.envVars], ['ULTRA_DIRECTORY_URL']);
  assert.equal(entry.optionalEnvVars.length, 1);
  assert.deepEqual({ ...entry.optionalEnvVars[0], options: [...entry.optionalEnvVars[0].options] }, {
    name: 'ULTRA_DIRECTORY_WRITE_TOKEN', label: 'GITHUB WRITE TOKEN', placeholder: 'github_pat_…', options: [],
  });
  assert.equal(entry.getUrl, 'https://github.com/settings/personal-access-tokens');
  assert.equal(keySetupRequirement('ultra-directory'), '', 'a hidden entry gates no control');
  // Absent from the panel's rows and from the POWER UP count, whether set or not.
  const status = keySetupStatus({ ULTRA_DIRECTORY_URL: 'https://raw.githubusercontent.com/g/r/main/ultra-directory.json', ULTRA_DIRECTORY_WRITE_TOKEN: 'github_pat_fixture' });
  assert.equal(status.keys.some((key) => key.id === 'ultra-directory'), false);
  assert.equal(status.total, keySetupStatus({}).total);
  assert.equal(status.setCount, keySetupStatus({}).setCount);
  const flat = JSON.stringify(status);
  assert.ok(!flat.includes('github_pat_fixture'), 'the write token leaked into status');
  assert.ok(!flat.includes('raw.githubusercontent.com/g/r'), 'the directory address leaked into status');
});

test('every help network and SMS relay name may be saved, and the values they carry validate', () => {
  const known = knownKeySetupEnvVars();
  for (const name of [
    'ULTRA_DIRECTORY_URL',
    'ULTRA_DIRECTORY_WRITE_TOKEN',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'ULTRA_SMS_RELAY_URL',
    'ULTRA_SMS_RELAY_TOKEN',
  ]) {
    assert.ok(known.has(name), `${name} may be saved from the box or POWER UP`);
  }
  // What the box and POWER UP actually post: a raw GitHub file address, a
  // fine-grained GitHub token, an E.164 number, and a gateway address.
  const raw = 'https://raw.githubusercontent.com/group/repo/main/ultra-directory.json';
  assert.deepEqual(validateKeySetupUpdates({ ULTRA_DIRECTORY_URL: raw }), { ok: true, updates: { ULTRA_DIRECTORY_URL: raw } });
  assert.equal(validateKeySetupUpdates({ ULTRA_DIRECTORY_WRITE_TOKEN: 'github_pat_11ABCDEFG_abcdefghijklmnop' }).ok, true);
  assert.deepEqual(validateKeySetupUpdates({ TWILIO_FROM_NUMBER: '+15065550100' }), { ok: true, updates: { TWILIO_FROM_NUMBER: '+15065550100' } });
  assert.equal(validateKeySetupUpdates({ ULTRA_SMS_RELAY_URL: 'https://relay.example/sms?team=7' }).ok, true);
  // A URL with a fragment would be cut at '#' by every dotenv reader, so the
  // route refuses it with its own sentence, which the box paints verbatim.
  const fragment = validateKeySetupUpdates({ ULTRA_DIRECTORY_URL: `${raw}#L1` });
  assert.equal(fragment.ok, false);
  assert.equal(fragment.error, 'ULTRA_DIRECTORY_URL contains a character that is not valid in a key (#, quotes, $, \\, or backtick)');
  assert.equal(validateKeySetupUpdates({ ULTRA_DIRECTORY_WRITE_TOKEN: null }).ok, true, 'the write token can be removed');
});

test('every LLM key carries an optional MODEL box; OpenRouter defaults to NVIDIA Nemotron 3 Ultra (free)', async () => {
  const { resolveLlmProvider } = await import('../server/providers/llm/ask.js');
  const known = knownKeySetupEnvVars();
  const status = keySetupStatus({ OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'openai/gpt-5.2' });
  for (const id of ['nvidia', 'xai', 'anthropic', 'openrouter']) {
    const entry = status.keys.find((key) => key.id === id);
    assert.equal(entry.optionalEnvVars.length, 1, id + ' has one MODEL box');
    const model = entry.optionalEnvVars[0];
    assert.equal(model.name, resolveLlmProvider(id).modelEnv, id + ' MODEL box writes the env var the server reads');
    assert.equal(model.placeholder, resolveLlmProvider(id).modelDefault, id + ' placeholder is the server default');
    assert.ok(known.has(model.name), id + ' MODEL env var may be saved');
    assert.ok(!entry.envVars.includes(model.name), id + ' MODEL never decides whether the key is set');
  }
  const openrouter = status.keys.find((key) => key.id === 'openrouter');
  assert.equal(openrouter.set, true, 'the key alone makes the slot set');
  assert.equal(openrouter.optionalEnvVars[0].value, 'openai/gpt-5.2', 'the model in use is shown; it is not a secret');
  assert.equal(openrouter.optionalEnvVars[0].placeholder, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.ok(openrouter.optionalEnvVars[0].options.includes('nvidia/nemotron-3-ultra-550b-a55b:free'));
  assert.equal(keySetupStatus({}).keys.find((key) => key.id === 'openrouter').optionalEnvVars[0].value, '');
  const flat = JSON.stringify(keySetupStatus({ OPENROUTER_API_KEY: 'SECRET-KEY-VALUE' }));
  assert.ok(!flat.includes('SECRET-KEY-VALUE'), 'a key value never appears in the status');
});

test('the bot swarms have POWER UP cards of their own: GROK BOT, its Chief of Staff webhook, its computer, and OPENAI DOTS', () => {
  const byId = Object.fromEntries(KEY_SETUP_KEYS.map((entry) => [entry.id, entry]));
  assert.deepEqual([...byId['grok-bot'].envVars], ['GROK_BOT_API_KEY']);
  assert.equal(byId['grok-bot'].optionalEnvVars[0].name, 'XAI_SWARM_MODEL');
  assert.deepEqual([...byId['grok-bot-chief-of-staff'].envVars], ['GROK_BOT_WEBHOOK_URL', 'GROK_BOT_WEBHOOK_KEY']);
  assert.deepEqual([...byId['grok-bot-computer'].envVars], ['GROK_BOT_GATEWAY_URL', 'GROK_BOT_GATEWAY_TOKEN']);
  assert.equal(byId['grok-bot-computer'].optionalEnvVars[0].name, 'GROK_BOT_GATEWAY_AGENT');
  assert.deepEqual([...byId['openai-dots'].envVars], ['OPENAI_DOTS_API_KEY']);
  assert.equal(byId['openai-dots'].optionalEnvVars[0].name, 'OPENAI_SWARM_MODEL');
  for (const id of ['grok-bot', 'grok-bot-chief-of-staff', 'grok-bot-computer', 'openai-dots']) {
    assert.equal(Boolean(byId[id].hidden), false, `${id} has its own row`);
    assert.equal(Boolean(byId[id].clientExposed), false, `${id} never reaches the browser bundle`);
  }
  // Apart from the Ask panel's xAI key and voice control's OpenAI key.
  assert.notEqual(byId['grok-bot'].group, byId.xai.group);
  assert.equal(byId['openai-dots'].group, undefined);
  // Any Grok Bot card powers the group, so the three count once.
  const none = keySetupStatus({});
  const webhook = 'https://api2.cursor.sh/automations/webhook/aut_7Hq2';
  assert.equal(keySetupStatus({ GROK_BOT_API_KEY: 'xai-k' }).setCount, none.setCount + 1);
  assert.equal(keySetupStatus({ GROK_BOT_WEBHOOK_URL: webhook, GROK_BOT_WEBHOOK_KEY: 'gbwh-k' }).setCount, none.setCount + 1);
  assert.equal(
    keySetupStatus({
      GROK_BOT_GATEWAY_URL: 'http://127.0.0.1:1340',
      GROK_BOT_GATEWAY_TOKEN: 'sand-k',
    }).setCount,
    none.setCount + 1,
  );
  assert.equal(
    keySetupStatus({ GROK_BOT_API_KEY: 'xai-k', GROK_BOT_WEBHOOK_URL: webhook, GROK_BOT_WEBHOOK_KEY: 'gbwh-k' }).setCount,
    none.setCount + 1,
  );
  assert.equal(keySetupStatus({ OPENAI_DOTS_API_KEY: 'sk-dots' }).setCount, none.setCount + 1);
  // The webhook address is Grok Bot's own: https, its backend, /automations/webhook/<id>.
  for (const url of [webhook, 'https://api.origin.cursor.com/automations/webhook/a-1_B.2']) {
    assert.equal(validateKeySetupUpdates({ GROK_BOT_WEBHOOK_URL: url }).ok, true, url);
  }
  for (const url of [
    'http://api2.cursor.sh/automations/webhook/aut_7Hq2',
    'https://hooks.evil.example/automations/webhook/aut_7Hq2',
    'https://api2.cursor.sh.evil.example/automations/webhook/aut_7Hq2',
    'https://cursor.sh.evil/automations/webhook/aut_7Hq2',
    'https://api2.cursor.sh:8443/automations/webhook/aut_7Hq2',
    'https://api2.cursor.sh/automations/webhook/aut_7Hq2?to=x',
    'https://api2.cursor.sh/automations/webhook/',
    'https://api2.cursor.sh/automations/webhook/a/b',
    'https://api2.cursor.sh/v1/responses',
    'https://me:pw@api2.cursor.sh/automations/webhook/aut_7Hq2',
  ]) {
    const verdict = validateKeySetupUpdates({ GROK_BOT_WEBHOOK_URL: url });
    assert.equal(verdict.ok, false, url);
    assert.match(verdict.error, /^GROK_BOT_WEBHOOK_URL must be the Webhook URL Grok Bot shows/);
  }
  assert.equal(validateKeySetupUpdates({ GROK_BOT_WEBHOOK_KEY: 'k'.repeat(513) }).ok, false);
  for (const url of [
    'http://127.0.0.1:1340',
    'http://localhost:1340',
    'http://100.64.1.2:1340',
    'https://box.ts.net',
  ]) {
    assert.equal(validateKeySetupUpdates({ GROK_BOT_GATEWAY_URL: url }).ok, true, url);
  }
  for (const url of [
    'https://evil.example:1340',
    'http://127.0.0.1:1340/api',
    'http://127.0.0.1:1340?x=1',
    'http://user:pw@127.0.0.1:1340',
    'https://box.ts.net.evil.example',
  ]) {
    const verdict = validateKeySetupUpdates({ GROK_BOT_GATEWAY_URL: url });
    assert.equal(verdict.ok, false, url);
    assert.match(verdict.error, /^GROK_BOT_GATEWAY_URL must be http:\/\/127\.0\.0\.1:1340/);
  }
  assert.equal(validateKeySetupUpdates({ GROK_BOT_GATEWAY_TOKEN: 'k'.repeat(513) }).ok, false);
  assert.equal(validateKeySetupUpdates({ GROK_BOT_GATEWAY_AGENT: 'Chief-of-Staff' }).ok, true);
  assert.equal(validateKeySetupUpdates({ GROK_BOT_GATEWAY_AGENT: 'Chief of Staff' }).ok, false);
  // A hand-edited address that fails the rule is there, but not set.
  const handEdited = keySetupStatus({ GROK_BOT_WEBHOOK_URL: 'https://hooks.evil.example/x', GROK_BOT_WEBHOOK_KEY: 'gbwh-k' });
  const row = handEdited.keys.find((key) => key.id === 'grok-bot-chief-of-staff');
  assert.deepEqual([row.present, row.set, row.unusable], [true, false, ['GROK_BOT_WEBHOOK_URL']]);
  // No value ever appears in the status.
  const flat = JSON.stringify(keySetupStatus({
    GROK_BOT_API_KEY: 'xai-SECRET-1',
    GROK_BOT_WEBHOOK_URL: webhook,
    GROK_BOT_WEBHOOK_KEY: 'gbwh-SECRET-2',
    GROK_BOT_GATEWAY_URL: 'http://127.0.0.1:1340',
    GROK_BOT_GATEWAY_TOKEN: 'sand-SECRET-4',
    OPENAI_DOTS_API_KEY: 'sk-SECRET-3',
  }));
  for (const secret of ['xai-SECRET-1', 'aut_7Hq2', 'gbwh-SECRET-2', 'sk-SECRET-3', 'sand-SECRET-4']) {
    assert.equal(flat.includes(secret), false, secret);
  }
});
