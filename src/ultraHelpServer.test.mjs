import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DEVICE_FEED_STORE, DEVICE_RECORDING_DIR } from './deviceFeedsCore.mjs';
import { ULTRA_NETWORK_TICK_MS } from '../server/shared/ultraNetwork.mjs';
import {
  ULTRA_SKILL_SETS,
  ULTRA_TOKEN_PATTERN,
  composeUltraToken,
  newUltraToken,
  openUltraToken,
  parseUltraTokenKey,
  readUltraTokenSkills,
  ultraTokenKeyId,
} from '../server/shared/ultraTokens.mjs';
import {
  handleUltraPhone,
  noteOutboundEnvSaved,
  noteSecurityFeedsSaved,
  noteUltraEndpoint,
  noteUltraPosition,
  onUltraPhoneFix,
  pollUltraNetworkOnce,
  ultraHelpProxy,
  ultraNetworkPins,
} from '../server/providers/ultra-help.js';

const PAGE = {
  origin: 'http://localhost:4173',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
};
const JSON_BODY = { 'content-type': 'application/json' };
const VAN_KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const HOME_KEY = 'QPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcba';
const VAN = {
  id: 'security-van',
  kind: 'security',
  name: 'Van 7',
  method: 'http-json',
  url: 'https://t.example/pos',
  reportKey: VAN_KEY,
};
const HOME = {
  id: 'security-home',
  kind: 'security',
  name: 'Home',
  method: 'http-json',
  url: 'https://t.example/home',
  reportKey: HOME_KEY,
};
const HOLDER = '100.80.30.40';
const UNKNOWN = `/ultra/help/uht1.${'0'.repeat(43)}`;
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
/** A well-formed replacement key: 32 counting bytes from `from`, never one byte repeated. */
const otherKeyText = (from) =>
  `${Buffer.from(Array.from({ length: 32 }, (_, i) => (from + i) & 0xff)).toString('hex')}\n`;

// ---- harness --------------------------------------------------------------

/** A request the provider reads with for-await, like a real IncomingMessage. */
function fakeRequest(
  url,
  { method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body } = {},
) {
  const payload =
    body === undefined
      ? []
      : Buffer.isBuffer(body)
        ? [body]
        : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(payload);
  Object.assign(req, {
    url,
    method,
    headers: { host: 'localhost:4173', ...headers },
    socket: { remoteAddress },
  });
  return req;
}

function fakeResponse(resolve) {
  return {
    headersSent: false,
    status: 0,
    headers: {},
    writeHead(status, headers = {}) {
      Object.assign(this, { status, headers, headersSent: true });
    },
    setTimeout() {},
    end(chunk) {
      const text = Buffer.from(chunk || '').toString('utf8');
      resolve({
        status: this.status,
        headers: this.headers,
        text,
        json: () => JSON.parse(text),
      });
    },
  };
}

function harness(plugin, { preview = false } = {}) {
  const uses = [];
  const server = { middlewares: { use: (...args) => uses.push(args) } };
  if (preview) plugin.configurePreviewServer(server);
  else plugin.configureServer(server);
  const handler = uses.find((args) => args[0] === '/api/ultra-help')[1];
  return (url, options) =>
    new Promise((resolve, reject) => {
      Promise.resolve(
        handler(fakeRequest(url, options), fakeResponse(resolve)),
      ).catch(reject);
    });
}

/** The listener's route, as device-feeds hands it every /ultra/* request. */
function phone(url, options = {}) {
  const req = fakeRequest(url, { remoteAddress: HOLDER, ...options });
  return phoneWith(req, url);
}

function phoneWith(req, url) {
  return new Promise((resolve, reject) => {
    Promise.resolve(
      handleUltraPhone(
        req,
        fakeResponse(resolve),
        new URL(url, 'http://localhost'),
      ),
    ).catch(reject);
  });
}

/** The holder's one route as a holder's GEVC polls it: the fixed path, the token as the bearer and never in it. */
const NETWORK_ROUTE = '/ultra/help/network';
const bearer = (token) => ({ authorization: `Bearer ${token}` });
function net(token, options = {}) {
  return phone(NETWORK_ROUTE, {
    ...options,
    headers: { ...bearer(token), ...(options.headers || {}) },
  });
}

function writeFeeds(root, feeds) {
  fs.writeFileSync(
    path.join(root, DEVICE_FEED_STORE),
    JSON.stringify({ version: 1, feeds }, null, 2),
  );
}

/**
 * A programmable outside world. `script(fn)` answers every call this
 * provider makes — a peer's /network, Nominatim, the directory, GitHub, the
 * SMS relay — and `calls` keeps every one of them, so a test can check what
 * was sent as closely as what came back. Nothing is answered until a test
 * says so: the default throws, like a machine with no internet.
 */
function setup({ feeds = [VAN] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-uht-'));
  fs.mkdirSync(path.join(root, 'config'));
  writeFeeds(root, feeds);
  const hardened = [];
  // A test can make every credential-store write fail, as a refused ACL does.
  let refuseWrites = false;
  const harden = (file) => {
    if (refuseWrites) return false;
    hardened.push({ file: path.basename(file), size: fs.statSync(file).size });
    return true;
  };
  const calls = [];
  let respond = () => null;
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
      init,
    };
    calls.push(call);
    const answer = await respond(call.url, call);
    if (!answer) throw new Error('offline');
    if (answer.hang) return new Promise(() => {});
    if (answer.throws) throw new Error(answer.throws);
    return new Response(answer.body === undefined ? '' : answer.body, {
      status: answer.status ?? 200,
      headers: answer.headers || { 'content-type': 'application/json' },
    });
  };
  const plugin = ultraHelpProxy({ sourceRoot: root, harden, fetchImpl });
  const request = harness(plugin);
  const post = (url, body, options = {}) =>
    request(url, { method: 'POST', headers: PAGE, body, ...options });
  const file = (name) => path.join(root, 'config', name);
  // What `npm run dev` stopped and started again does to this module: point
  // it at another root so the memory is dropped, then back at the same files.
  const restart = () => {
    ultraHelpProxy({
      sourceRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'gev-uht-')),
    });
    const back = harness(
      ultraHelpProxy({ sourceRoot: root, harden, fetchImpl }),
    );
    return {
      request: back,
      post: (url, body, options = {}) =>
        back(url, { method: 'POST', headers: PAGE, body, ...options }),
    };
  };
  return {
    root,
    plugin,
    request,
    post,
    file,
    harden,
    hardened,
    calls,
    restart,
    script: (fn) => {
      respond = fn;
    },
    refuseWrites: (on) => {
      refuseWrites = on;
    },
    poll: pollUltraNetworkOnce,
    pins: ultraNetworkPins,
  };
}

/** Let the detached work a press or a poll started run to the end. */
const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

/** Set these names for one test and put the environment back whatever happens. */
async function withEnv(values, run) {
  const before = new Map(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const json = (value) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

const SAINT_JOHN = json({
  address: {
    house_number: '10',
    road: 'Example St',
    city: 'Saint John',
    state: 'New Brunswick',
    country_code: 'ca',
  },
  display_name: '10 Example St, Saint John',
});
const PLACE = '10 Example St, Saint John, New Brunswick (45.2700, -66.0600)';
const PEER_TOKEN = `uht1.${'Pp7'.repeat(14)}A`;
const PEER_ADDRESS = 'https://peer.tail9.ts.net';
/** The legacy joined shape, as a hand-kept directory file may still carry it. */
const PEER_LINK = `${PEER_ADDRESS}/ultra/help/${PEER_TOKEN}`;
/** Every token one machine handed out polls this one URL; the token rides the header. */
const PEER_NETWORK = `${PEER_ADDRESS}/ultra/help/network`;
const ANN_TOKEN = `uht1.${'An4'.repeat(14)}B`;
const ANN_ADDRESS = 'https://ann.tail9.ts.net';
const ANN_LINK = `${ANN_ADDRESS}/ultra/help/${ANN_TOKEN}`;
const OTHER_TOKEN = `uht1.${'Ot8'.repeat(14)}C`;
/** The bearer a poller sends, as the fetch fixture records it. */
const bearerOf = (call) => String(call.headers?.Authorization || '');

/**
 * A token for the tests, with Network on as the box mints one: the page
 * opens only with Network on and SEND HELP pressed. Cases that need a
 * reachable holder call askForHelp. A body anytime flag is ignored by the
 * mint and stored false.
 */
async function mint(
  post,
  body = { label: 'Neighbour', sms: true, voice: true, network: true },
) {
  const answer = await post('/tokens', body);
  assert.equal(answer.status, 200, answer.text);
  return answer.json();
}

/** Press SEND HELP for one package so its holder pages are open. */
async function askForHelp(post, feedId = VAN.id) {
  const feed = feedId === HOME.id ? HOME : VAN;
  noteUltraPosition({
    key: feed.reportKey,
    name: feed.name,
    lat: 45.27,
    lon: -66.06,
    at: Date.now(),
  });
  const answer = await post('/release', { incident: 'other', feedId });
  let detail = 'SEND HELP was refused';
  try {
    const body = answer.json();
    if (body && typeof body.error === 'string') detail = body.error;
  } catch {
    /* A refusal that is not JSON stays on the status code. */
  }
  assert.equal(answer.status, 200, detail);
  return answer;
}

function withClock(start) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    tick: (ms) => {
      now += ms;
    },
    restore: () => {
      Date.now = real;
    },
  };
}

// ---- owner routes ---------------------------------------------------------

test('mint: a sealed token, a write-once key, and a status that never carries the token', async () => {
  const { post, request, file, hardened } = setup();
  const before = await mint(post);
  assert.match(before.revealed.token, ULTRA_TOKEN_PATTERN);
  assert.doesNotMatch(before.revealed.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(before.revealed.address, '', 'no tailnet address yet');
  assert.ok(!('link' in before.revealed), 'the handout is never a joined link');
  assert.equal(before.revealed.label, 'Neighbour');
  noteUltraEndpoint(['http://192.168.1.5:44173']);
  const minted = await mint(post, {
    label: 'Courier',
    sms: false,
    voice: false,
  });
  const { token } = minted.revealed;
  // Network off: the token opens nothing, so no address is handed out with
  // it (and a LAN address never is).
  assert.ok(!('address' in minted.revealed));
  assert.ok(!('link' in minted.revealed));
  assert.notEqual(token, before.revealed.token);
  assert.match(
    fs.readFileSync(file('ultra-tokens.key'), 'utf8'),
    /^[0-9a-f]{64}\n$/,
  );
  const storeText = fs.readFileSync(file('ultra-tokens.json'), 'utf8');
  assert.ok(
    !storeText.includes(token) && !storeText.includes(before.revealed.token),
    'the store holds hashes and ciphertext, never a token',
  );
  const store = JSON.parse(storeText);
  assert.equal(store.tokens.length, 2);
  const record = store.tokens[1];
  assert.match(record.id, /^t-[0-9a-f]{16}$/);
  assert.match(record.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(record.sealed), ['v', 'iv', 'tag', 'data']);
  assert.equal(Buffer.from(record.sealed.iv, 'base64').length, 12);
  assert.equal(Buffer.from(record.sealed.tag, 'base64').length, 16);
  assert.deepEqual(
    [record.feedId, record.label, record.sms, record.voice, record.revokedAt],
    ['security-van', 'Courier', false, false, null],
  );
  assert.equal(typeof record.createdAt, 'number');
  // The hardener ran on the staged temp of each file while it was still empty,
  // and the key was made once: the second mint reused it.
  const staged = hardened.filter((call) => call.size === 0);
  assert.ok(
    staged.some((call) =>
      /^\.ultra-tokens\.key\.[0-9a-f]{8}\.tmp$/.test(call.file),
    ),
  );
  assert.ok(
    staged.some((call) =>
      /^\.ultra-tokens\.json\.[0-9a-f]{8}\.tmp$/.test(call.file),
    ),
  );
  assert.equal(
    hardened.filter((call) => call.file.includes('ultra-tokens.key')).length,
    1,
  );
  if (process.platform !== 'win32') {
    for (const name of ['ultra-tokens.key', 'ultra-tokens.json'])
      assert.equal(fs.statSync(file(name)).mode & 0o777, 0o600, name);
  }
  for (const url of ['/status', '/']) {
    const answer = await request(url);
    assert.equal(answer.status, 200, url);
    const status = answer.json();
    assert.equal(status.editable, true);
    assert.equal(status.tokenStore, 'ok');
    assert.equal(status.helpBase, 'http://192.168.1.5:44173/ultra/help/');
    // Each Ultra cell carries its map id, never its key.
    assert.deepEqual(status.packages, [
      {
        id: 'security-van',
        name: 'Van 7',
        mapId: 'device-security-van',
        method: 'http-json',
        record: false,
        recordKm: null,
      },
    ]);
    assert.match(status.camLink, /\/ultra\/[A-Za-z0-9_-]{43}\/cam$/);
    assert.equal(status.ownerNumber, '');
    assert.deepEqual([status.inbox, status.unread], [[], 0]);
    assert.ok(Array.isArray(status.models));
    assert.equal(status.tokens.length, 2);
    const row = status.tokens[1];
    assert.equal(row.id, minted.revealed.id);
    assert.equal(row.label, 'Courier');
    assert.equal(row.fingerprint, record.hash.slice(0, 8));
    assert.deepEqual(
      [row.sms, row.voice, row.messages, row.lastAt, row.revokedAt],
      [false, false, 0, null, null],
    );
    assert.ok(!('hash' in row) && !('sealed' in row) && !('token' in row));
    assert.ok(!('revealed' in status));
    assert.deepEqual(row.skills, []);
    assert.equal(row.encrypted, false);
    const text = answer.text;
    assert.ok(
      !text.includes(token) &&
        !text.includes(before.revealed.token) &&
        !text.includes(record.hash),
    );
  }
});

test('skill sets are part of the token string, and Encrypt hides them there', async () => {
  const { post, request, file } = setup();
  noteUltraEndpoint(['http://192.168.1.5:44173']);
  const refused = await post('/tokens', {
    label: 'Neighbour',
    skills: ['doctor'],
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().error, 'Unknown skill set');
  const tooMany = await post('/tokens', {
    label: 'Neighbour',
    custom: ['a', 'b', 'c', 'd', 'e', 'f'],
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json().error, 'At most 5 custom skill sets');
  const clash = await post('/tokens', {
    label: 'Neighbour',
    custom: [
      'Search and Rescue Specialist Alpha',
      'Search and Rescue Specialist Beta',
    ],
  });
  assert.equal(clash.status, 400);
  assert.equal(
    clash.json().error,
    'Two custom skill sets would share one token code',
  );
  assert.ok(!clash.text.includes('Specialist'));
  const minted = await mint(post, {
    label: 'Neighbour',
    network: true,
    skills: ['rg', 'dr', 'pm'],
    custom: ['  ', 'Coast Guard', 'Swift Water'],
    encrypt: false,
  });
  const token = minted.revealed.token;
  assert.equal(token.slice(48), '.s.dr.pm.rg.xcoast-guard.xswift-water');
  assert.ok(!token.includes('Doctor'));
  const row = minted.tokens.find((item) => item.id === minted.revealed.id);
  assert.deepEqual(
    row.skills.map((item) => item.label),
    ['Doctor', 'Paramedic', 'Ranger', 'Coast Guard', 'Swift Water'],
  );
  assert.equal(row.encrypted, false);
  assert.ok(!JSON.stringify(minted.tokens).includes(token));
  const storeText = fs.readFileSync(file('ultra-tokens.json'), 'utf8');
  assert.ok(!storeText.includes(token));
  const savedNeighbour = JSON.parse(storeText).tokens.find(
    (item) => item.label === 'Neighbour',
  );
  assert.deepEqual(savedNeighbour.skills, []);
  assert.equal(savedNeighbour.encrypted, false);
  assert.match(savedNeighbour.policyMac, /^[0-9a-f]{64}$/);
  await askForHelp(post);
  assert.equal((await net(token)).status, 200);
  assert.equal((await net(token.slice(0, 48))).status, 404);
  const hidden = await mint(post, {
    label: 'Medic',
    network: true,
    skills: ['dr'],
    encrypt: true,
  });
  const hiddenToken = hidden.revealed.token;
  assert.match(hiddenToken, /\.e\.[A-Za-z0-9_-]+$/);
  assert.ok(!hiddenToken.includes('.s.'));
  assert.ok(!hiddenToken.includes('Doctor'));
  const hiddenRow = hidden.tokens.find(
    (item) => item.id === hidden.revealed.id,
  );
  assert.equal(hiddenRow.encrypted, true);
  assert.equal(hiddenRow.skills[0].label, 'Doctor');
  const savedMedic = JSON.parse(
    fs.readFileSync(file('ultra-tokens.json'), 'utf8'),
  ).tokens.find((item) => item.label === 'Medic');
  assert.deepEqual(savedMedic.skills, []);
  assert.equal(savedMedic.encrypted, true);
  assert.match(savedMedic.policyMac, /^[0-9a-f]{64}$/);
  assert.ok(
    !fs.readFileSync(file('ultra-tokens.json'), 'utf8').includes(hiddenToken),
  );
  const key = parseUltraTokenKey(
    fs.readFileSync(file('ultra-tokens.key'), 'utf8'),
  );
  assert.deepEqual(
    readUltraTokenSkills(hiddenToken, key).skills.map((item) => item.label),
    ['Doctor'],
  );
  assert.deepEqual(readUltraTokenSkills(hiddenToken).skills, []);
  assert.equal((await net(hiddenToken)).status, 200);
  const plain = await mint(post, {
    label: 'Plain',
    network: true,
    skills: [],
    custom: [],
    encrypt: false,
  });
  assert.equal(plain.revealed.token.length, 48);
  assert.equal((await net(plain.revealed.token)).status, 200);
  const quiet = await mint(post, { label: 'Quiet', encrypt: true });
  assert.match(quiet.revealed.token, /\.e\./);
  assert.deepEqual(
    quiet.tokens.find((item) => item.id === quiet.revealed.id).skills,
    [],
  );
  const skilled = composeUltraToken(newUltraToken(), [
    { code: 'ff', label: 'Firefighter' },
  ]);
  const added = await post('/network', {
    add: true,
    address: PEER_ADDRESS,
    token: skilled,
    name: 'Pat',
  });
  assert.equal(added.status, 200, added.text);
  const peer = added.json().network.entries.find((item) => item.name === 'Pat');
  assert.deepEqual(peer.skills, ['Firefighter']);
  assert.equal(peer.encrypted, undefined);
  assert.ok(!added.text.includes(skilled));
  assert.ok(!added.text.includes('uht1.'));
  const sealed = composeUltraToken(
    newUltraToken(),
    [{ code: 'dr', label: 'Doctor' }],
    { encrypt: true, key: Buffer.alloc(32, 4) },
  );
  const sealedAdd = await post('/network', {
    add: true,
    address: ANN_ADDRESS,
    token: sealed,
    name: 'Ann',
  });
  assert.equal(sealedAdd.status, 200, sealedAdd.text);
  const ann = sealedAdd
    .json()
    .network.entries.find((item) => item.name === 'Ann');
  assert.equal(ann.encrypted, true);
  assert.equal(ann.skills, undefined);
  assert.ok(!JSON.stringify(ann).includes('Doctor'));
  assert.ok(!sealedAdd.text.includes(sealed));
  // The status poll still answers, and still does not carry a token.
  const status = await request('/status');
  assert.equal(status.status, 200);
  assert.ok(!status.text.includes(token));
  assert.ok(!status.text.includes(hiddenToken));
  assert.ok(!status.text.includes(skilled));
});

test('reveal, edit, revoke, remove, purge, and the owner number', async () => {
  const { post, request, file, hardened } = setup();
  const { id, token } = (await mint(post)).revealed;
  const shown = await post('/tokens', { reveal: true, id });
  assert.equal(shown.status, 200, shown.text);
  assert.equal(shown.json().revealed.token, token);
  assert.equal(shown.json().revealed.id, id);
  // The owner's number is saved on this machine and never shown to a
  // holder: a token has no status route, during a call too.
  const saved = await post('/number', { number: '+1 (506) 555-0199' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json().ownerNumber, '+15065550199');
  assert.match(
    fs.readFileSync(file('ultra-help.json'), 'utf8'),
    /"number": "\+15065550199"/,
  );
  assert.ok(
    hardened.some(
      (call) =>
        /^\.ultra-help\.json\.[0-9a-f]{8}\.tmp$/.test(call.file) &&
        call.size === 0,
    ),
    'the numbers file goes through the credential-store path',
  );
  const status = (token) => phone(`/ultra/help/${token}/status`);
  assert.equal((await status(token)).status, 404);
  await askForHelp(post);
  assert.equal((await status(token)).status, 404);
  const edited = await post('/tokens', { edit: true, id, sms: false });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual(
    [edited.json().tokens[0].sms, edited.json().tokens[0].voice],
    [false, true],
  );
  assert.equal((await status(token)).status, 404);
  const renamed = await post('/tokens', { edit: true, id, label: 'Next door' });
  assert.equal(renamed.json().tokens[0].label, 'Next door');
  assert.equal(
    (await post('/tokens', { edit: true, id, label: ' ' })).json().error,
    'Name the Ultra Token holder',
  );
  assert.equal(
    (await post('/tokens', { edit: true, id: 't-0000000000000000' })).status,
    404,
  );
  // Revoke: the next holder request and a reveal both 404; the row stays.
  assert.equal((await net(token)).status, 200);
  const revoked = await post('/tokens', { revoke: true, id });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(typeof revoked.json().tokens[0].revokedAt, 'number');
  assert.equal(revoked.json().tokens[0].label, 'Next door');
  assert.equal((await net(token)).status, 404);
  const gone = await post('/tokens', { reveal: true, id });
  assert.equal(gone.status, 404);
  assert.equal(gone.json().error, 'No such token');
  // Purge removes only revoked records; remove takes any.
  const second = await mint(post, { label: 'Courier', network: true });
  assert.equal(second.tokens.length, 2);
  assert.equal((await net(second.revealed.token)).status, 200);
  const purged = await post('/tokens', { purge: true });
  assert.deepEqual(
    purged.json().tokens.map((row) => row.id),
    [second.revealed.id],
  );
  const removed = await post('/tokens', {
    remove: true,
    id: second.revealed.id,
  });
  assert.deepEqual(removed.json().tokens, []);
  assert.equal(
    (await post('/tokens', { remove: true, id: second.revealed.id })).status,
    404,
  );
  assert.equal((await net(second.revealed.token)).status, 404);
  // '' and null clear the number; anything that is not E.164 is refused.
  assert.equal((await post('/number', { number: '' })).json().ownerNumber, '');
  await post('/number', { number: '+15065550199' });
  assert.equal(
    (await post('/number', { number: null })).json().ownerNumber,
    '',
  );
  const bad = await post('/number', { number: '5065550100' });
  assert.equal(bad.status, 400);
  assert.equal(
    bad.json().error,
    'Need a +number like +15065550100, or leave it empty',
  );
  assert.equal((await request('/status')).json().ownerNumber, '');
  const unnamed = await post('/tokens', { label: '' });
  assert.equal(unnamed.status, 400);
  assert.equal(unnamed.json().error, 'Name the Ultra Token holder');
});

test('mint with two packages needs a choice; with none it refuses; an orphaned token is unknown', async () => {
  const { post, request, root } = setup({ feeds: [VAN, HOME] });
  const vague = await post('/tokens', { label: 'Neighbour' });
  assert.equal(vague.status, 400);
  assert.equal(vague.json().error, 'Choose which package');
  assert.equal(
    (await post('/tokens', { label: 'Neighbour', feedId: 'nope' })).status,
    400,
  );
  const chosen = await mint(post, {
    label: 'Neighbour',
    network: true,
    feedId: 'security-home',
  });
  assert.equal(chosen.tokens[0].feedId, 'security-home');
  assert.deepEqual(
    chosen.packages.map((item) => item.id),
    ['security-van', 'security-home'],
  );
  const { token } = chosen.revealed;
  await askForHelp(post, 'security-home');
  assert.equal((await net(token)).json().name, 'Home');
  writeFeeds(root, []);
  const none = await post('/tokens', { label: 'Courier' });
  assert.equal(none.status, 400);
  assert.equal(none.json().error, 'No Ultra Security Package is saved yet');
  assert.equal((await net(token)).status, 404);
  assert.equal((await net(token)).text, 'Not found');
  // The box is told, and SHARE will not hand out a link that only 404s.
  const orphan = (await request('/status')).json().tokens[0];
  assert.equal(orphan.orphaned, true);
  assert.equal(orphan.revokedAt, null);
  const reveal = await post('/tokens', { reveal: true, id: orphan.id });
  assert.equal(reveal.status, 409);
  assert.match(reveal.json().error, /package that was removed/);
  writeFeeds(root, [VAN, HOME]);
  assert.equal((await request('/status')).json().tokens[0].orphaned, false);
  assert.equal(
    (await post('/tokens', { reveal: true, id: orphan.id })).status,
    200,
  );
});

test('the key file protection is asked again on read: widened access is said, restored access clears it', async () => {
  const { root, post, request, harden, file } = setup();
  const { id, token } = (await mint(post, { label: 'Keeper', network: true }))
    .revealed;
  assert.equal((await request('/status')).json().tokenStore, 'ok');
  // The same files, with a check that answers for the key file's rights.
  let restricted = true;
  ultraHelpProxy({ sourceRoot: root, harden, verify: () => restricted });
  assert.equal((await request('/status')).json().tokenStore, 'ok');
  restricted = false;
  // The answer is kept while the file's stat is unchanged, so the widened
  // rights are seen once the file is touched (as a chmod or icacls does).
  fs.utimesSync(
    file('ultra-tokens.key'),
    new Date(1_700_000_000_000),
    new Date(1_700_000_000_000),
  );
  assert.equal((await request('/status')).json().tokenStore, 'key-exposed');
  // The key is still the key: admission, reveal and a mint all work.
  assert.equal((await net(token)).status, 200);
  const shown = await post('/tokens', { reveal: true, id });
  assert.equal(shown.status, 200, shown.text);
  assert.equal(shown.json().revealed.token, token);
  assert.equal(shown.json().tokenStore, 'key-exposed');
  assert.equal(
    (await mint(post, { label: 'Second' })).tokenStore,
    'key-exposed',
  );
  // Restored rights are seen the same way; a check that throws is exposed.
  restricted = true;
  fs.utimesSync(
    file('ultra-tokens.key'),
    new Date(1_700_000_100_000),
    new Date(1_700_000_100_000),
  );
  assert.equal((await request('/status')).json().tokenStore, 'ok');
  ultraHelpProxy({
    sourceRoot: root,
    harden,
    verify: () => {
      throw new Error('no tools');
    },
  });
  assert.equal((await request('/status')).json().tokenStore, 'key-exposed');
  // A test's own hardener stands for the file's protection unless it brings a check.
  ultraHelpProxy({ sourceRoot: root, harden });
  assert.equal((await request('/status')).json().tokenStore, 'ok');
});

test('the store-wide check tells a row removed, reordered or stripped by hand, and an owner action accepts the file', async () => {
  const { post, request, file } = setup();
  const first = (await mint(post, { label: 'First', network: true })).revealed;
  const second = (await mint(post, { label: 'Second', network: true }))
    .revealed;
  const read = () =>
    JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  const write = (doc) =>
    fs.writeFileSync(file('ultra-tokens.json'), JSON.stringify(doc, null, 2));
  const stamped = read();
  assert.match(stamped.storeMac, /^[0-9a-f]{64}$/);
  assert.equal((await request('/status')).json().tokenStore, 'ok');
  // A row removed by hand: said, and the row that is left still admits its
  // holder (each record answers for itself), while the removed one is gone.
  write({
    ...stamped,
    tokens: stamped.tokens.filter((t) => t.id !== first.id),
  });
  assert.equal((await request('/status')).json().tokenStore, 'store-changed');
  assert.equal((await net(second.token)).status, 200);
  assert.equal((await net(first.token)).status, 404);
  // A holder's request does not launder it: the check stays as it was.
  assert.equal(read().storeMac, stamped.storeMac);
  assert.equal((await request('/status')).json().tokenStore, 'store-changed');
  // Reordered rows, and a row stripped of its own check, are told the same.
  write({ ...stamped, tokens: [...stamped.tokens].reverse() });
  assert.equal((await request('/status')).json().tokenStore, 'store-changed');
  const [a, b] = stamped.tokens;
  const { policyMac: _dropped, ...bare } = b;
  write({ ...stamped, tokens: [a, bare] });
  assert.equal((await request('/status')).json().tokenStore, 'store-changed');
  // The owner's own action on a named record accepts the file as it is.
  write({
    ...stamped,
    tokens: stamped.tokens.filter((t) => t.id !== first.id),
  });
  const revoked = await post('/tokens', { revoke: true, id: second.id });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.json().tokenStore, 'ok');
  assert.notEqual(read().storeMac, stamped.storeMac);
  assert.equal((await request('/status')).json().tokenStore, 'ok');
  // A file from before the check earns one once a seal in it opens.
  const { storeMac: _old, ...legacy } = read();
  write(legacy);
  assert.equal((await request('/status')).json().tokenStore, 'ok');
  assert.match(read().storeMac ?? '', /^[0-9a-f]{64}$/);
  assert.equal((await request('/status')).json().tokenStore, 'ok');
});

test('key file semantics: no-key, key-invalid, a changed key, an unreadable store, reset', async () => {
  const { post, request, file } = setup();
  const { id, token } = (await mint(post)).revealed;
  await askForHelp(post);
  fs.rmSync(file('ultra-tokens.key'));
  assert.equal((await request('/status')).json().tokenStore, 'no-key');
  for (const body of [{ label: 'Courier' }, { reveal: true, id }]) {
    const refused = await post('/tokens', body);
    assert.equal(refused.status, 409, refused.text);
    assert.match(
      refused.json().error,
      /^Not saved: the token key file is missing; revoke the existing tokens or RESET TOKENS, then mint again$/,
    );
  }
  assert.ok(
    !fs.existsSync(file('ultra-tokens.key')),
    'a mint never recreates the key beside existing tokens',
  );
  // Holders are still admitted by hash; revoke still works.
  assert.equal((await net(token)).status, 200);
  assert.equal((await post('/tokens', { revoke: true, id })).status, 200);
  assert.equal((await net(token)).status, 404);
  // With no live token left the missing key blocks nothing: the refusal's
  // own advice (revoke, then mint again) works, and the next mint makes a
  // fresh key beside the revoked record.
  assert.equal((await request('/status')).json().tokenStore, 'ok');
  const again = await mint(post);
  assert.match(
    fs.readFileSync(file('ultra-tokens.key'), 'utf8'),
    /^[0-9a-f]{64}\n$/,
  );
  assert.equal(again.tokens.length, 2);
  assert.equal(again.tokens.filter((item) => item.revokedAt).length, 1);
  // A malformed key is never overwritten or regenerated.
  fs.writeFileSync(file('ultra-tokens.key'), 'abc');
  assert.equal((await request('/status')).json().tokenStore, 'key-invalid');
  const invalid = await post('/tokens', { label: 'Courier' });
  assert.equal(invalid.status, 409);
  assert.match(
    invalid.json().error,
    /^Not saved: the token key file \(ultra-tokens\.key\) is not a valid key/,
  );
  assert.doesNotMatch(invalid.json().error, /config[\\/]/, 'path-free');
  assert.equal(fs.readFileSync(file('ultra-tokens.key'), 'utf8'), 'abc');
  // Reset wants a confirm, deletes both files, and the next mint makes a fresh key.
  assert.equal((await post('/tokens', { reset: true })).status, 400);
  const reset = await post('/tokens', { reset: true, confirm: true });
  assert.equal(reset.status, 200, reset.text);
  assert.deepEqual([reset.json().tokens, reset.json().tokenStore], [[], 'ok']);
  assert.ok(!fs.existsSync(file('ultra-tokens.key')));
  assert.ok(!fs.existsSync(file('ultra-tokens.json')));
  const fresh = await mint(post);
  assert.match(
    fs.readFileSync(file('ultra-tokens.key'), 'utf8'),
    /^[0-9a-f]{64}\n$/,
  );
  assert.notEqual(fresh.revealed.token, token);
  // A key that changed under a sealed token: admission works, reveal refuses,
  // and the box says the key changed (the store names the key it was written
  // under), instead of leaving the owner to infer it from the reveal.
  const freshKey = parseUltraTokenKey(
    fs.readFileSync(file('ultra-tokens.key'), 'utf8'),
  );
  assert.equal(
    JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8')).keyId,
    ultraTokenKeyId(freshKey),
  );
  fs.writeFileSync(file('ultra-tokens.key'), otherKeyText(100));
  assert.equal((await request('/status')).json().tokenStore, 'key-changed');
  // Not tampered: a replaced key opens nothing, and the row stays usable.
  assert.equal(
    (await request('/status'))
      .json()
      .tokens.find((item) => item.id === fresh.revealed.id).tampered,
    false,
  );
  assert.equal((await net(fresh.revealed.token)).status, 200);
  // The header's keyId is under the store-wide check: taking it out by hand
  // while the check stays is a changed file, said as such.
  const headed = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  assert.match(headed.storeMac, /^[0-9a-f]{64}$/);
  delete headed.keyId;
  fs.writeFileSync(file('ultra-tokens.json'), JSON.stringify(headed));
  assert.equal((await request('/status')).json().tokenStore, 'store-changed');
  // A store from before the header and the check is not judged: no keyId,
  // no storeMac, no verdict.
  const { storeMac: _preCheck, ...unchecked } = headed;
  fs.writeFileSync(file('ultra-tokens.json'), JSON.stringify(unchecked));
  assert.equal((await request('/status')).json().tokenStore, 'ok');
  fs.writeFileSync(
    file('ultra-tokens.json'),
    JSON.stringify({ ...headed, keyId: ultraTokenKeyId(freshKey) }),
  );
  assert.equal((await request('/status')).json().tokenStore, 'key-changed');
  // A revoke under the replaced key keeps naming the key the seals were made
  // under: the new key has opened nothing yet, so the box still says so.
  const revokedUnderNew = await post('/tokens', {
    revoke: true,
    id: fresh.revealed.id,
  });
  assert.equal(revokedUnderNew.status, 200, revokedUnderNew.text);
  assert.equal(revokedUnderNew.json().tokenStore, 'key-changed');
  assert.equal(
    JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8')).keyId,
    ultraTokenKeyId(freshKey),
  );
  // A mint under the new key seals something it opens, and the header moves.
  const underNew = await mint(post, { label: 'Under new key' });
  assert.equal(underNew.tokenStore, 'ok');
  assert.equal(
    JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8')).keyId,
    ultraTokenKeyId(
      parseUltraTokenKey(fs.readFileSync(file('ultra-tokens.key'), 'utf8')),
    ),
  );
  // Back to the single replaced-key row for the rest of this test.
  fs.writeFileSync(
    file('ultra-tokens.json'),
    JSON.stringify({ ...headed, keyId: ultraTokenKeyId(freshKey) }),
  );
  assert.equal((await request('/status')).json().tokenStore, 'key-changed');
  const changed = await post('/tokens', {
    reveal: true,
    id: fresh.revealed.id,
  });
  assert.equal(changed.status, 409);
  assert.equal(
    changed.json().error,
    'This token cannot be shown any more (the key file changed): revoke it and mint a new one',
  );
  // An unreadable store: holders 404, every write but reset is refused, the file is untouched.
  fs.writeFileSync(file('ultra-tokens.json'), '{not json');
  assert.equal((await request('/status')).json().tokenStore, 'unreadable');
  assert.deepEqual((await request('/status')).json().tokens, []);
  assert.equal((await net(fresh.revealed.token)).status, 404);
  for (const body of [
    { label: 'Courier' },
    { revoke: true, id: fresh.revealed.id },
    { reveal: true, id: fresh.revealed.id },
    { purge: true },
  ]) {
    const broken = await post('/tokens', body);
    assert.equal(broken.status, 409, broken.text);
    assert.equal(
      broken.json().error,
      'Not saved: the token store exists but cannot be read; fix or RESET TOKENS',
    );
  }
  assert.equal(fs.readFileSync(file('ultra-tokens.json'), 'utf8'), '{not json');
  const cleared = await post('/tokens', { reset: true, confirm: true });
  assert.equal(cleared.json().tokenStore, 'ok');
  assert.ok(!fs.existsSync(file('ultra-tokens.json')));
});

test('a flag flipped in the token file is refused and does not spend the miss budget', async () => {
  const { post, request, file } = setup();
  const minted = await mint(post);
  const { token, id } = minted.revealed;
  const store = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  const beforeMac = store.tokens[0].policyMac;
  assert.match(beforeMac, /^[0-9a-f]{64}$/);
  store.tokens[0].anytime = true;
  fs.writeFileSync(file('ultra-tokens.json'), JSON.stringify(store));
  for (let i = 0; i < 20; i += 1) {
    const answer = await net(token, {
      remoteAddress: '100.88.8.8',
    });
    assert.equal(answer.status, 404, `tampered ${i + 1}`);
    assert.equal(answer.text, 'Not found');
    assert.equal(answer.headers['Content-Type'], 'text/plain');
    assert.equal(
      answer.headers['Content-Security-Policy'],
      "default-src 'none'",
    );
    assert.equal(answer.headers['X-Frame-Options'], 'DENY');
  }
  assert.equal(
    (await phone(UNKNOWN, { remoteAddress: '100.88.8.8' })).status,
    404,
    'a tampered link is not a miss, so a first real miss is still served',
  );
  const row = (await request('/status'))
    .json()
    .tokens.find((item) => item.id === id);
  assert.equal(row.tampered, true);
  assert.equal(row.anytime, true);
  const after = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  assert.equal(after.tokens[0].policyMac, beforeMac);
  assert.equal(after.tokens[0].anytime, true);
});

test('a copied token does not take the real link, and a deleted check beside another token is not filled back in', async () => {
  const { post, request, file } = setup();
  const first = await mint(post, { label: 'Neighbour', network: true });
  const { token, id } = first.revealed;
  const second = await mint(post, {
    label: 'Courier',
    sms: true,
    network: true,
    anytime: false,
  });
  await askForHelp(post);
  const store = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  const real = store.tokens.find((item) => item.id === id);
  const evil = {
    ...real,
    id: 't-9999999999999999',
    label: 'Copied',
    anytime: false,
    network: false,
  };
  delete evil.policyMac;
  store.tokens.unshift(evil);
  const other = store.tokens.find((item) => item.id === second.revealed.id);
  delete other.policyMac;
  other.anytime = true;
  fs.writeFileSync(file('ultra-tokens.json'), JSON.stringify(store));
  // The link follows the seal that still opens, not the copy placed above it.
  const admitted = await net(token);
  assert.equal(admitted.status, 200, admitted.text);
  assert.equal(admitted.json().released, true);
  for (let i = 0; i < 20; i += 1) {
    const answer = await net(second.revealed.token, {
      remoteAddress: '100.77.7.7',
    });
    assert.equal(answer.status, 404, `deleted check ${i + 1}`);
    assert.equal(answer.text, 'Not found');
    assert.equal(
      answer.headers['Content-Security-Policy'],
      "default-src 'none'",
    );
    assert.equal(answer.headers['X-Frame-Options'], 'DENY');
  }
  assert.equal(
    (await phone(UNKNOWN, { remoteAddress: '100.77.7.7' })).status,
    404,
    'a deleted check is not a miss, so a first real miss is still served',
  );
  const rows = (await request('/status')).json().tokens;
  assert.equal(rows.find((item) => item.id === evil.id).tampered, true);
  assert.equal(rows.find((item) => item.id === id).tampered, false);
  assert.equal(rows.find((item) => item.id === id).anytime, false);
  assert.equal(
    rows.find((item) => item.id === second.revealed.id).tampered,
    true,
  );
  assert.equal(
    rows.find((item) => item.id === second.revealed.id).anytime,
    true,
  );
  const saved = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  const savedOther = saved.tokens.find(
    (item) => item.id === second.revealed.id,
  );
  assert.equal(savedOther.policyMac, undefined);
  assert.equal(savedOther.anytime, true);
  assert.equal(
    saved.tokens.some((item) => item.id === evil.id),
    true,
  );
  // Minting another token must not fill the deleted check back in.
  const extra = await mint(post, { label: 'After' });
  const minted = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  assert.equal(
    minted.tokens.find((item) => item.id === second.revealed.id).policyMac,
    undefined,
  );
  assert.match(
    minted.tokens.find((item) => item.id === extra.revealed.id).policyMac,
    /^[0-9a-f]{64}$/,
  );
  const edit = await post('/tokens', {
    edit: true,
    id: second.revealed.id,
    sms: false,
  });
  assert.equal(edit.status, 409);
  assert.equal(
    edit.json().error,
    'This token was changed in the token file: revoke it and mint a new one',
  );
  const still = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  assert.equal(
    still.tokens.find((item) => item.id === second.revealed.id).sms,
    true,
  );
  const revoked = await post('/tokens', {
    revoke: true,
    id: second.revealed.id,
  });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal((await net(second.revealed.token)).status, 404);
});

test('a token file with no check at all still admits, and the next status fills that check in', async () => {
  const { post, request, file } = setup();
  const { token, id } = (await mint(post)).revealed;
  const store = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  delete store.tokens[0].policyMac;
  store.tokens[0].sms = false;
  fs.writeFileSync(file('ultra-tokens.json'), JSON.stringify(store));
  await askForHelp(post);
  // Wiping the only check looks the same as a file from before checks: the
  // link admits, and the flags now in the file are what get checked.
  const admitted = await net(token);
  assert.equal(admitted.status, 200, admitted.text);
  assert.equal(admitted.json().released, true);
  const after = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  assert.match(after.tokens[0].policyMac, /^[0-9a-f]{64}$/);
  assert.equal(after.tokens[0].sms, false);
  const row = (await request('/status'))
    .json()
    .tokens.find((item) => item.id === id);
  assert.equal(row.tampered, false);
  assert.equal(row.sms, false);
  const again = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  assert.equal(again.tokens[0].policyMac, after.tokens[0].policyMac);
});

test('mint refuses a 201st token and keeps the ones already stored', async () => {
  const { post, file } = setup();
  const first = await mint(post);
  await askForHelp(post);
  const store = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  const kept = store.tokens[0];
  const extras = [];
  for (let i = 1; i < 200; i += 1) {
    extras.push({
      ...kept,
      id: `t-b${String(i).padStart(15, '0')}`,
      label: 'Kept',
      hash: crypto.createHash('sha256').update(`extra-${i}`).digest('hex'),
    });
  }
  const seeded = { version: 1, tokens: [kept, ...extras] };
  fs.writeFileSync(file('ultra-tokens.json'), JSON.stringify(seeded));
  const refused = await post('/tokens', { label: 'One more', anytime: true });
  assert.equal(refused.status, 409);
  assert.match(
    refused.json().error,
    /^Not saved: At most 200 help tokens are kept\. Remove one, then mint again$/,
  );
  const after = JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8'));
  assert.equal(after.tokens.length, 200);
  assert.equal((await net(first.revealed.token)).status, 200);
  const removed = await post('/tokens', { remove: true, id: extras[0].id });
  assert.equal(removed.status, 200, removed.text);
  const again = await mint(post, { label: 'After', network: true });
  assert.equal(again.tokens.length, 200);
  assert.equal((await net(again.revealed.token)).status, 200);
});

test('owner routes: loopback, local Host, same-origin JSON only; preview is read-only', async () => {
  const { plugin, request } = setup();
  const refused = async (options, status, pattern) => {
    const answer = await request('/tokens', {
      method: 'POST',
      headers: PAGE,
      body: { label: 'X' },
      ...options,
    });
    assert.equal(answer.status, status, answer.text);
    if (pattern) assert.match(answer.json().error, pattern);
  };
  await refused(
    { headers: { ...PAGE, 'x-forwarded-for': '203.0.113.9' } },
    403,
    /proxied/,
  );
  await refused({ remoteAddress: '192.168.1.2' }, 403);
  await refused({ headers: { ...PAGE, origin: 'http://evil.test' } }, 403);
  await refused(
    { headers: { ...PAGE, 'sec-fetch-site': 'cross-site' } },
    403,
    /only its own page/,
  );
  await refused({ headers: { ...PAGE, 'content-type': 'text/plain' } }, 415);
  await refused(
    { body: `{"label":"${'x'.repeat(20_000)}"}` },
    413,
    /^Request too large$/,
  );
  await refused({ body: '{' }, 400, /^Bad JSON$/);
  await refused({ body: 'null' }, 400, /^Bad JSON$/);
  await refused({ body: '[]' }, 400, /^Bad JSON$/);
  assert.equal(
    (await request('/status', { headers: { 'sec-fetch-site': 'cross-site' } }))
      .status,
    403,
  );
  // Nothing under /api/ultra-help serves a file.
  for (const url of [
    '/ultra-tokens.json',
    '/config/ultra-tokens.key',
    '/../config/ultra-inbox.json',
  ]) {
    const answer = await request(url);
    assert.equal(answer.status, 404, url);
    assert.equal(answer.json().error, 'Not found');
  }
  const preview = harness(plugin, { preview: true });
  for (const [url, body] of [
    ['/tokens', { label: 'X' }],
    ['/number', { number: '+15065550199' }],
    ['/inbox', { clear: true }],
  ]) {
    const answer = await preview(url, { method: 'POST', headers: PAGE, body });
    assert.equal(answer.status, 403, url);
    assert.equal(
      answer.json().error,
      'Editing is available under the dev server only',
    );
  }
  const status = await preview('/status');
  assert.equal(status.status, 200);
  assert.equal(status.json().editable, false);
  assert.equal(status.json().tokens.length, 0);
});

// ---- holder routes --------------------------------------------------------

test('holder routes: the location poll is all a token has, and one 404 for everything else', async () => {
  const { post, root } = setup();
  const { token } = (await mint(post)).revealed;
  await askForHelp(post);
  // The poll: GET /ultra/help/network with the token as the bearer, JSON
  // under the phone routes' own strict headers, varying by that header and
  // never cached.
  const poll = await net(token);
  assert.equal(poll.status, 200);
  assert.equal(poll.headers['Content-Type'], 'application/json');
  assert.equal(poll.headers['Content-Security-Policy'], "default-src 'none'");
  assert.equal(poll.headers['X-Frame-Options'], 'DENY');
  assert.equal(poll.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(poll.headers['Cache-Control'], 'no-store, private');
  assert.equal(poll.headers.Vary, 'Authorization');
  assert.equal(poll.json().released, true);
  assert.equal(
    (await phone(`${NETWORK_ROUTE}/`, { headers: bearer(token) })).status,
    200,
    'a trailing slash is the same route',
  );
  // The scheme word in any case; the surrounding blanks forgiven.
  for (const header of [
    `bearer ${token}`,
    `BEARER ${token}`,
    `  Bearer   ${token}  `,
  ]) {
    assert.equal(
      (await phone(NETWORK_ROUTE, { headers: { authorization: header } }))
        .status,
      200,
      JSON.stringify(header),
    );
  }
  // No page, no status and no message box, during a call too: the uniform
  // 404, with the body and headers of the phone routes. The old form, with
  // the token in the path, is one of them: a credential never comes from
  // the URL, and sending one there tells the sender nothing.
  const mangled = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  for (const [i, [url, options]] of [
    [`/ultra/help/${token}`],
    [`/ultra/help/${token}/`],
    [`/ultra/help/${token}/status`],
    [`/ultra/help/${token}/message`],
    [`/ultra/help/${token}/network`],
    [`/ultra/help/${mangled}/network`],
    [UNKNOWN],
    [`/ultra/help/${VAN_KEY}`],
    [`/ultra/${token}`],
    [`/ultra/${token}/cam`],
    [`/ultra/help/${token}/cam`],
    [`/ultra/help/${token}/picture`],
    [`/ultra/help/${token}/network/x`],
    ['/ultra/help'],
    [`/ultra/help/${token.toUpperCase()}/network`],
    // The right route, the wrong header: missing, another scheme, two
    // tokens, a mangled or short or upper-cased token, a token with the
    // path's old shape around it.
    [NETWORK_ROUTE],
    [NETWORK_ROUTE, { headers: { authorization: token } }],
    [NETWORK_ROUTE, { headers: { authorization: `Basic ${token}` } }],
    [NETWORK_ROUTE, { headers: { authorization: `Token ${token}` } }],
    [NETWORK_ROUTE, { headers: { authorization: `Bearer ${token} ${token}` } }],
    [NETWORK_ROUTE, { headers: { authorization: 'Bearer' } }],
    [NETWORK_ROUTE, { headers: { authorization: 'Bearer ' } }],
    [NETWORK_ROUTE, { headers: bearer(mangled) }],
    [NETWORK_ROUTE, { headers: bearer(token.slice(0, 48 - 1)) }],
    [NETWORK_ROUTE, { headers: bearer(token.toUpperCase()) }],
    [NETWORK_ROUTE, { headers: bearer(`/ultra/help/${token}`) }],
    [NETWORK_ROUTE, { headers: bearer(VAN_KEY) }],
    // A good bearer on another route opens nothing either.
    [`/ultra/help/${token}/network`, { headers: bearer(token) }],
    ['/ultra/help/status', { headers: bearer(token) }],
    ['/ultra/help/network/x', { headers: bearer(token) }],
    ['/ultra/help', { headers: bearer(token) }],
    [`/ultra/${token}`, { headers: bearer(token) }],
  ].entries()) {
    // Each from its own address: most of these are misses, and twenty from
    // one address in a minute would be refused outright (tested below).
    const answer = await phone(url, {
      ...options,
      remoteAddress: `100.70.${i}.1`,
    });
    const why = `${url} ${JSON.stringify(options || {})}`;
    assert.equal(answer.status, 404, why);
    assert.equal(answer.text, 'Not found', why);
    assert.equal(answer.headers['Content-Type'], 'text/plain', why);
    assert.equal(
      answer.headers['Content-Security-Policy'],
      "default-src 'none'",
      why,
    );
    assert.equal(answer.headers['X-Frame-Options'], 'DENY', why);
    assert.ok(!answer.text.includes(token), why);
  }
  for (const route of ['message', 'status', 'network']) {
    const posted = await phone(`/ultra/help/${route}`, {
      method: 'POST',
      headers: { ...JSON_BODY, ...bearer(token) },
      body: { text: 'hello' },
    });
    assert.equal(posted.status, 404, `POST ${route}`);
  }
  // The holder's own poll still gets through: a known token on the right
  // route spends no miss budget.
  assert.equal((await net(token)).status, 200);
  // The package removed: the same token is orphaned until it is back.
  writeFeeds(root, []);
  assert.equal((await net(token)).status, 404);
  writeFeeds(root, [VAN]);
  await askForHelp(post);
  assert.equal((await net(token)).status, 200);
});

test('holder routes: the old token-in-path form and a bad bearer are misses; many tokens on one address are each their own', async () => {
  const { post } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    const first = (await mint(post, { label: 'Sam', network: true })).revealed;
    const second = (await mint(post, { label: 'Ann', network: true })).revealed;
    const FROM = { remoteAddress: '100.88.8.8' };
    // Twenty old-form requests with a live token in the path: each is the
    // uniform 404 and a miss, so the twenty-first guess from that address
    // is refused outright, as every unknown credential is.
    for (let i = 0; i < 20; i += 1) {
      const answer = await phone(`/ultra/help/${first.token}/network`, FROM);
      assert.deepEqual(
        [answer.status, answer.text],
        [404, 'Not found'],
        `old form ${i + 1}`,
      );
    }
    assert.equal(
      (await phone(UNKNOWN, FROM)).status,
      429,
      'the budget is spent',
    );
    // A minute on, the same token sent the right way is served, and spends
    // nothing.
    clock.tick(60_001);
    for (let i = 0; i < 25; i += 1)
      assert.equal((await net(first.token, FROM)).status, 200, `poll ${i}`);
    assert.equal((await phone(UNKNOWN, FROM)).status, 404, 'no miss spent');
    clock.tick(60_001);
    // A missing or malformed Authorization on the right route is a miss too.
    for (const headers of [
      {},
      { authorization: first.token },
      { authorization: `Basic ${first.token}` },
      { authorization: `Bearer ${first.token} extra` },
      { authorization: 'Bearer nope' },
    ]) {
      for (let i = 0; i < 4; i += 1)
        assert.equal(
          (await phone(NETWORK_ROUTE, { ...FROM, headers })).status,
          404,
          JSON.stringify(headers),
        );
    }
    assert.equal((await phone(UNKNOWN, FROM)).status, 429, 'twenty misses');
    clock.tick(60_001);
    assert.equal((await net(first.token, FROM)).status, 200);
    // Two tokens valid at once on one machine: both poll, each by its own
    // bearer. Revoking one leaves the other polling, and the revoked one
    // is a miss from then on (the per-holder revocation this shape is for).
    assert.deepEqual((await net(first.token)).json(), { released: false });
    assert.deepEqual((await net(second.token)).json(), { released: false });
    await askForHelp(post);
    assert.equal((await net(first.token)).json().released, true);
    assert.equal((await net(second.token)).json().released, true);
    const revoked = await post('/tokens', { revoke: true, id: first.id });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal((await net(first.token)).status, 404);
    assert.equal((await net(second.token)).json().released, true);
    assert.equal((await net(second.token, FROM)).status, 200);
    for (let i = 0; i < 20; i += 1)
      assert.equal((await net(first.token, FROM)).status, 404, `revoked ${i}`);
    assert.equal(
      (await phone(UNKNOWN, FROM)).status,
      429,
      'a revoked token is a miss',
    );
    // The other holder, from an address that guessed nothing, polls on.
    assert.equal((await net(second.token)).json().released, true);
  } finally {
    clock.restore();
  }
});

test('a token has no message box, and a call received is written behind to a secret-free inbox', async () => {
  await withPeer(async ({ post, request, script, poll, file, hardened }) => {
    // The message box is gone: a post to it is the uniform 404, refused
    // before the body is read, during the owner's own call too.
    const { token } = (await mint(post)).revealed;
    await askForHelp(post);
    const req = fakeRequest(`/ultra/help/${token}/message`, {
      method: 'POST',
      headers: JSON_BODY,
      remoteAddress: HOLDER,
      body: { text: 'Smoke at the back door', from: 'Sam' },
    });
    const refused = await phoneWith(req, `/ultra/help/${token}/message`);
    assert.deepEqual([refused.status, refused.text], [404, 'Not found']);
    assert.equal(req.readableDidRead, false, 'refused before the body');
    assert.deepEqual((await request('/status')).json().inbox, []);
    // A call for help from the home list is a row...
    assert.equal((await post('/release', { standDown: true })).status, 200);
    script((url) => (url === PEER_NETWORK ? releasedBody() : null));
    await poll(Date.now());
    await flush();
    const row = (await request('/status'))
      .json()
      .inbox.find((item) => item.kind === 'release');
    assert.ok(row, 'the call is in the inbox');
    // ...and the file lands after the debounce, through the credential-store
    // path (its staged temp hardened while still empty), with no secret in it.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const saved = fs.readFileSync(file('ultra-inbox.json'), 'utf8');
    assert.equal(JSON.parse(saved).messages[0].kind, 'release');
    assert.ok(
      hardened.some(
        (call) =>
          call.size === 0 &&
          /^\.ultra-inbox\.json\.[0-9a-f]{8}\.tmp$/.test(call.file),
      ),
    );
    assert.ok(
      !saved.includes(PEER_TOKEN) &&
        !saved.includes(PEER_LINK) &&
        !saved.includes(token),
    );
    if (process.platform !== 'win32')
      assert.equal(fs.statSync(file('ultra-inbox.json')).mode & 0o777, 0o600);
    // Later writes rewrite that same file in place, with no hardener...
    const staged = () =>
      hardened.filter((call) => /^\.ultra-inbox\.json\./.test(call.file))
        .length;
    const before = staged();
    const inode = fs.statSync(file('ultra-inbox.json')).ino;
    assert.equal((await post('/inbox', { read: true })).status, 200);
    assert.equal(staged(), before);
    assert.equal(fs.statSync(file('ultra-inbox.json')).ino, inode);
    assert.notEqual(
      JSON.parse(fs.readFileSync(file('ultra-inbox.json'), 'utf8')).messages[0]
        .readAt,
      null,
    );
    // ...but one deleted meanwhile is made again through the credential-store
    // path, never re-created in place with the folder's permissions.
    fs.rmSync(file('ultra-inbox.json'));
    assert.equal(
      (await post('/inbox', { remove: true, id: row.id })).status,
      200,
    );
    assert.equal(staged(), before + 1);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file('ultra-inbox.json'), 'utf8')).messages,
      [],
    );
  });
});

test('unknown phone keys are budgeted per address, and a known key still gets through', async () => {
  const { root } = setup();
  const clock = withClock(Date.UTC(2026, 9, 1, 12));
  const guess = (i) => `/ultra/${String(i).padStart(43, 'G')}`;
  const FROM = { remoteAddress: '192.168.1.50' };
  try {
    assert.equal((await phone(`/ultra/${VAN_KEY}`, FROM)).status, 200);
    for (let i = 0; i < 20; i += 1)
      assert.equal((await phone(guess(i), FROM)).status, 404, `miss ${i + 1}`);
    const flooded = await phone(guess(20), FROM);
    assert.deepEqual([flooded.status, flooded.text], [429, 'Wait']);
    // Another address is its own budget.
    assert.equal(
      (await phone(guess(21), { remoteAddress: '192.168.1.51' })).status,
      404,
    );
    // A malformed key costs nothing and never reads the store.
    assert.equal((await phone('/ultra/short', FROM)).status, 404);
    // The phone's own key still gets through from the spent address, every route.
    assert.equal((await phone(`/ultra/${VAN_KEY}`, FROM)).status, 200);
    assert.equal((await phone(`/ultra/${VAN_KEY}/cam`, FROM)).status, 200);
    // NEW KEY: the retired key the last read named still goes to the full
    // check, which reads the store and refuses it; that read names the new
    // key, so the phone's new link works from the same spent address.
    writeFeeds(root, [{ ...VAN, reportKey: HOME_KEY }]);
    assert.equal((await phone(`/ultra/${VAN_KEY}`, FROM)).status, 404);
    assert.equal((await phone(`/ultra/${HOME_KEY}`, FROM)).status, 200);
    assert.equal((await phone(guess(22), FROM)).status, 429);
    clock.tick(60_001);
    assert.equal((await phone(guess(23), FROM)).status, 404);
  } finally {
    clock.restore();
  }
});

test('the location poll answers the tailnet only: a LAN neighbour, a Funnel visitor or a rebinding page gets the unknown 404', async () => {
  const { post } = setup();
  const { token } = (await mint(post)).revealed;
  await askForHelp(post);
  const ask = (remoteAddress, headers = {}) =>
    net(token, { remoteAddress, headers });
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  try {
    // During a live call, with the right token, from where the token's
    // holder is not: each is the same 404 an unknown token gets.
    for (const [remoteAddress, headers, why] of [
      ['192.168.1.20', {}, 'a LAN neighbour reading the directory'],
      [
        '10.0.0.7',
        { host: 'box.tail1.ts.net:44173' },
        'a LAN socket naming the tailnet host',
      ],
      ['203.0.113.9', {}, 'a public address'],
      [
        '127.0.0.1',
        { 'x-forwarded-for': '203.0.113.9' },
        'a Funnel visitor behind tailscale serve',
      ],
      [
        '127.0.0.1',
        { 'x-forwarded-for': '100.64.0.9, 203.0.113.9' },
        'a chain of proxies',
      ],
      [
        '100.64.0.9',
        { host: 'rebind.evil:44173' },
        'a rebinding page in a tailnet browser',
      ],
      ['100.64.0.9', { host: '' }, 'no Host'],
      ['100.64.0.9', { host: 'box:44173' }, 'a single-label name'],
    ]) {
      const refused = await ask(remoteAddress, headers);
      assert.deepEqual([refused.status, refused.text], [404, 'Not found'], why);
    }
    assert.deepEqual(
      warned.filter((line) =>
        /refused|192.168|203.0|10.0.0.7|100.64.0.9/.test(line),
      ),
      [],
      'a refusal is not logged',
    );
    for (let i = 0; i < 25; i += 1) await ask('192.168.1.20');
    assert.equal(
      (await phone(UNKNOWN, { remoteAddress: '100.64.0.21' })).status,
      404,
      'refusals spend no budget',
    );
  } finally {
    console.warn = warn;
  }
  // The tailnet, by address, by name, by IPv6, behind tailscale serve, and
  // this machine with no proxy in between.
  for (const [remoteAddress, headers] of [
    ['100.64.0.9', {}],
    ['100.64.0.9', { host: 'box.tail1.ts.net:44173' }],
    ['::ffff:100.101.2.3', { host: '100.101.0.1:44173' }],
    ['fd7a:115c:a1e0::9', { host: '[fd7a:115c:a1e0::1]:44173' }],
    [
      '127.0.0.1',
      { 'x-forwarded-for': '100.64.0.9', host: 'box.tail1.ts.net' },
    ],
    [
      '127.0.0.1',
      { 'x-forwarded-for': 'fd7a:115c:a1e0:ab12::9', host: 'box.tail1.ts.net' },
    ],
    ['127.0.0.1', {}],
  ]) {
    const answer = await ask(remoteAddress, headers);
    assert.equal(
      answer.status,
      200,
      `${remoteAddress} ${JSON.stringify(headers)}`,
    );
    assert.equal(answer.json().released, true);
  }
});

test('budgets: 60 requests and 20 misses a minute per address', async () => {
  const { post } = setup();
  const { token } = (await mint(post)).revealed;
  const clock = withClock(Date.UTC(2026, 8, 27, 12));
  await askForHelp(post);
  const status = (remoteAddress, headers = {}) =>
    net(token, { remoteAddress, headers });
  try {
    // 60 requests a minute from one address, whatever they ask for.
    for (let i = 0; i < 60; i += 1)
      assert.equal(
        (await status('100.64.0.2')).status,
        200,
        `request ${i + 1}`,
      );
    const flooded = await status('100.64.0.2');
    assert.equal(flooded.status, 429);
    assert.equal(flooded.text, 'Wait');
    assert.equal((await status('100.64.0.3')).status, 200);
    clock.tick(60_001);
    assert.equal((await status('100.64.0.2')).status, 200);
    // 20 misses a minute: the 21st unknown link from one address is refused,
    // that address is not served at all, and another address still is.
    const warned = [];
    const warn = console.warn;
    console.warn = (...args) => warned.push(args.map(String).join(' '));
    let guessed;
    try {
      const guessing = {
        remoteAddress: '100.64.0.4',
        headers: { 'tailscale-user-login': 'mallory@example.com' },
      };
      for (let i = 0; i < 20; i += 1)
        assert.equal((await phone(UNKNOWN, guessing)).status, 404);
      guessed = await phone(UNKNOWN, guessing);
      // Said once, with the address; a login header on any socket but
      // loopback is the guesser's own claim and is not repeated.
      assert.equal(warned.length, 1);
      assert.ok(warned[0].includes('100.64.0.4'), warned[0]);
      assert.ok(!warned[0].includes('tailnet user'), warned[0]);
      // Behind tailscale serve (loopback socket) the header is tailscale's,
      // repeated capped to printable ASCII.
      const tailnet = {
        remoteAddress: '127.0.0.1',
        headers: {
          'x-forwarded-for': '100.64.0.9',
          'tailscale-user-login': `alice@example.com${'x'.repeat(200)}`,
        },
      };
      for (let i = 0; i < 21; i += 1) await phone(UNKNOWN, tailnet);
      assert.equal(warned.length, 2);
      assert.ok(
        warned[1].includes('tailnet user alice@example.com'),
        warned[1],
      );
      assert.ok(!warned[1].includes(''));
      assert.ok(warned[1].length < warned[1].indexOf('tailnet user') + 100);
    } finally {
      console.warn = warn;
    }
    assert.equal(guessed.status, 429);
    assert.equal(guessed.text, 'Wait');
    assert.equal((await status('100.64.0.4')).status, 429);
    assert.equal(
      (await phone(UNKNOWN, { remoteAddress: '100.64.0.5' })).status,
      404,
    );
    assert.equal((await status('100.64.0.5')).status, 200);
    clock.tick(60_001);
    assert.equal((await status('100.64.0.4')).status, 200);
    // Behind tailscale serve the socket is loopback and the holder is the
    // forwarded hop; on any other socket the header is ignored.
    const hop = (forwarded, remoteAddress = '127.0.0.1') =>
      phone(UNKNOWN, {
        remoteAddress,
        headers: { 'x-forwarded-for': forwarded },
      });
    for (let i = 0; i < 20; i += 1) await hop('100.64.0.9');
    assert.equal((await hop('100.64.0.9')).status, 429);
    assert.equal((await hop('100.64.0.10')).status, 404);
    assert.equal((await hop('100.64.0.9', '100.64.0.6')).status, 404);
    assert.equal(
      (await status('100.64.0.10', { 'x-forwarded-for': '100.64.0.9' })).status,
      200,
    );
  } finally {
    clock.restore();
  }
});

test('a token shares nothing until SEND HELP, and a stored anytime flag changes nothing', async () => {
  // Holding a token tells nobody anything until the owner presses SEND HELP,
  // and then the location poll is still all it reaches. Asking the mint for
  // anytime does not change that.
  const { post, request } = setup();
  const dark = (await post('/tokens', { label: 'Dark', network: true })).json()
    .revealed.token;
  const marked = (
    await post('/tokens', { label: 'Marked', network: true, anytime: true })
  ).json().revealed.token;
  noteUltraPosition({
    key: VAN_KEY,
    name: 'Van 7',
    lat: 45.27,
    lon: -66.06,
    at: Date.now(),
  });
  const shut = async (token, what) => {
    for (const [name, answer] of [
      ['page', await phone(`/ultra/help/${token}`)],
      ['status', await phone(`/ultra/help/${token}/status`)],
      [
        'message',
        await phone(`/ultra/help/${token}/message`, {
          method: 'POST',
          headers: JSON_BODY,
          body: { text: 'let me in' },
        }),
      ],
    ]) {
      assert.equal(answer.status, 404, `${what}: ${name}`);
      assert.equal(answer.text, 'Not found', `${what}: ${name}`);
    }
  };
  const poll = async (token) => (await net(token)).json();

  // Quiet: the poll says "not now" and nothing else opens.
  await shut(dark, 'quiet');
  await shut(marked, 'marked');
  assert.deepEqual(await poll(dark), { released: false });
  assert.deepEqual(await poll(marked), { released: false });
  assert.equal(
    (await request('/status'))
      .json()
      .tokens.every((item) => item.anytime === false),
    true,
  );

  // SEND HELP: the poll carries the call, and still nothing else opens.
  assert.equal((await post('/release', { incident: 'fire' })).status, 200);
  await shut(dark, 'asking');
  await shut(marked, 'asking marked');
  assert.equal((await poll(dark)).released, true);
  assert.equal((await poll(marked)).released, true);

  // STAND DOWN: "not now" again.
  assert.equal((await post('/release', { standDown: true })).status, 200);
  assert.deepEqual(await poll(dark), { released: false });
  assert.deepEqual(await poll(marked), { released: false });
  assert.equal(
    (await request('/status'))
      .json()
      .tokens.every((item) => item.anytime === false),
    true,
  );
});

test('a token with Network off opens nothing, even while SEND HELP is pressed', async () => {
  // Both conditions or nothing (owner ruling, 2026-09-30): the token's
  // Network on, and its package's call running.
  const { post } = setup();
  const off = (await mint(post, { label: 'Courier', sms: true, voice: true }))
    .revealed;
  await askForHelp(post);
  const FROM = { remoteAddress: '100.88.8.8' };
  const poll = () => net(off.token, FROM);
  for (let i = 0; i < 20; i += 1) {
    const answer = await poll();
    assert.deepEqual(
      [answer.status, answer.text],
      [404, 'Not found'],
      `call on, Network off: ${i + 1}`,
    );
  }
  assert.equal(
    (await phone(UNKNOWN, FROM)).status,
    404,
    'twenty dark answers spent no miss, so a first real miss is still served',
  );
  // NETWORK ON: the poll carries the call...
  await post('/tokens', { edit: true, id: off.id, network: true });
  assert.equal((await poll()).json().released, true);
  // ...and NETWORK OFF shuts it again at once.
  await post('/tokens', { edit: true, id: off.id, network: false });
  assert.equal((await poll()).status, 404);
});

test('a retired report key stops being admitted at once, and never speaks for another package', async () => {
  // NEW KEY (and removing a package) must take the old phone link out of
  // service immediately: it can press SEND HELP, and a process that had once
  // seen a fix under it used to go on admitting it until the next restart.
  const { post, root, request } = setup();
  noteUltraPosition({
    key: VAN_KEY,
    name: 'Van 7',
    lat: 45.27,
    lon: -66.06,
    at: Date.now(),
  });
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 200, 'live to start');
  const ROTATED = 'rotatedKEY'.repeat(5).slice(0, 43);
  writeFeeds(root, [{ ...VAN, reportKey: ROTATED }]);
  const help = (body) =>
    phone(`/ultra/${VAN_KEY}/help`, {
      method: 'POST',
      headers: JSON_BODY,
      body,
    });
  for (const [what, answer] of [
    ['poll', await phone(`/ultra/${VAN_KEY}`)],
    ['camera page', await phone(`/ultra/${VAN_KEY}/cam`)],
    ['release', await help({ lat: 1.234, lon: 2.345, incident: 'fire' })],
    ['stand down', await help({ standDown: true })],
  ]) {
    assert.equal(answer.status, 404, `${what} on the retired key`);
    assert.equal(answer.text, 'Not found', what);
  }
  const after = (await request('/status')).json();
  assert.equal(after.release, null, 'the retired key released nothing');
  assert.equal(
    after.position,
    null,
    'and its last fix is forgotten, so the desktop cannot publish it either',
  );
  // The rotated key is the one that works now.
  assert.equal((await phone(`/ultra/${ROTATED}`)).status, 200);
});

// ---- the phone's poll -----------------------------------------------------

test('phone poll: { command, notify } popped together, the command slot untouched by a call for help', async () => {
  await withPeer(async ({ post, request, script, poll, clock }) => {
    const added = await post('/network', {
      add: true,
      address: ANN_ADDRESS,
      token: ANN_TOKEN,
      name: 'Ann',
    });
    assert.equal(added.status, 200, added.text);
    const annNetwork = `${ANN_ADDRESS}/ultra/help/network`;
    // The phone has reported in, so the map can send it a camera command.
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    let calling = [PEER_NETWORK];
    script((url) => (calling.includes(url) ? releasedBody() : null));
    // Sam asks for help: one card, and the command slot stays empty.
    await poll(Date.now());
    await flush(8);
    const alone = (await phone(`/ultra/${VAN_KEY}`)).json();
    assert.equal(
      alone.command,
      null,
      'a call for help never fills the command slot',
    );
    assert.deepEqual(
      alone.notify.map((item) => [item.kind, item.label]),
      [['release', 'Sam']],
    );
    // A camera command and Ann's call come in together: one answer pops both.
    clock.tick(30_000);
    const camera = await post('/camera', { role: 'rear' });
    assert.equal(camera.status, 200, camera.text);
    assert.equal(camera.json().pending.kind, 'camera');
    calling = [annNetwork];
    await poll(Date.now());
    await flush(8);
    const both = (await phone(`/ultra/${VAN_KEY}`)).json();
    assert.deepEqual(
      [both.command.kind, both.command.role],
      ['camera', 'rear'],
    );
    assert.deepEqual(
      both.notify.map((item) => item.label),
      ['Ann'],
    );
    assert.deepEqual((await phone(`/ultra/${VAN_KEY}`)).json(), {
      command: null,
      notify: [],
      release: null,
    });
    const status = (await request('/status')).json();
    assert.deepEqual(
      status.inbox.map((item) => item.label),
      ['Ann', 'Sam'],
    );
    assert.ok(
      status.inbox.every((item) => typeof item.deliveredAt === 'number'),
    );
    assert.equal(status.unread, 2);
    assert.equal(status.pending, null, 'the command was popped');
    // The owner's inbox actions.
    const [second, first] = status.inbox;
    const readOne = (await post('/inbox', { read: true, id: first.id })).json();
    assert.deepEqual(
      readOne.inbox.map((item) => item.readAt !== null),
      [false, true],
    );
    assert.equal(readOne.unread, 1);
    assert.equal((await post('/inbox', { read: true })).json().unread, 0);
    const removed = (
      await post('/inbox', { remove: true, id: second.id })
    ).json();
    assert.deepEqual(
      removed.inbox.map((item) => item.id),
      [first.id],
    );
    const cleared = (await post('/inbox', { clear: true })).json();
    assert.deepEqual([cleared.inbox, cleared.unread], [[], 0]);
    assert.equal((await post('/inbox', {})).status, 400);
  });
  // The phone page shows the cards, and reads notify before the command.
  const page = await phone(`/ultra/${VAN_KEY}/cam`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<section id="inbox" hidden>/);
  assert.match(
    page.text,
    /<button id="sound" type="button">Sound on<\/button>/,
  );
  assert.match(page.text, /<ul id="notices"><\/ul>/);
  assert.ok(
    page.text.indexOf('body.notify.forEach(show)') <
      page.text.indexOf('body.command.kind'),
  );
  assert.match(page.text, /\[300, 120, 300, 120, 600\]/);
  assert.match(page.text, /\[500, 150, 500, 150, 900\]/);
  assert.doesNotMatch(page.text, /innerHTML/);
  assert.ok(!page.text.includes('uht1.'));
});

// ---- SEND HELP ------------------------------------------------------------

test('owner release: a four-hour window, EXTEND, STAND DOWN, and the plea for the saved helpers', async () => {
  const { post, request, file, hardened, script, poll, plugin } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    const none = await post('/release', { incident: 'fire' });
    assert.equal(none.status, 409);
    assert.equal(
      none.json().error,
      'No position yet: open the phone link on the phone, or press SEND HELP there',
    );
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    const sent = await post('/release', { incident: 'fire' });
    assert.equal(sent.status, 200, sent.text);
    const release = sent.json().release;
    assert.deepEqual(
      [
        release.at,
        release.until - release.at,
        release.lat,
        release.lon,
        release.fixAt,
        release.feedId,
        release.incident,
        release.holders,
        release.watching,
      ],
      [
        Date.now(),
        14_400_000,
        45.27,
        -66.06,
        Date.now(),
        'security-van',
        'fire',
        0,
        0,
      ],
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8')).releases,
      [
        {
          at: release.at,
          until: release.until,
          lat: 45.27,
          lon: -66.06,
          fixAt: release.fixAt,
          renewedAt: release.at,
          feedId: 'security-van',
          incident: 'fire',
        },
      ],
    );
    assert.ok(
      hardened.some(
        (call) =>
          call.size === 0 &&
          /^\.ultra-help\.json\.[0-9a-f]{8}\.tmp$/.test(call.file),
      ),
      'the release goes through the credential-store path',
    );
    // A word that is not a class of its own is 'other'.
    assert.equal(
      (await post('/release', { incident: 'bomb' })).json().release.incident,
      'other',
    );
    // EXTEND HELP: the time help was first sent stays, the window moves out.
    const first = release.at;
    clock.tick(60_000);
    const again = (await post('/release', { incident: 'fire' })).json().release;
    assert.deepEqual([again.at, again.until - Date.now()], [first, 14_400_000]);
    // The plea is composed here, from this machine's own reverse geocode,
    // and the phone gets one card for the saved helpers.
    await post('/contacts', {
      label: 'Neighbour',
      number: '+15065550100',
      kind: 'other',
    });
    script((url) =>
      url.startsWith('https://nominatim.openstreetmap.org/reverse')
        ? SAINT_JOHN
        : null,
    );
    clock.tick(60_000);
    await post('/camera', { role: 'rear' });
    const extended = (await post('/release', { incident: 'fire' })).json()
      .release;
    await poll(Date.now());
    const plea = `Please HELP you are close by, to ${PLACE} of victim in progress, fire thank you.`;
    assert.equal((await request('/status')).json().release.plea, plea);
    const popped = (await phone(`/ultra/${VAN_KEY}`)).json();
    assert.equal(popped.command.kind, 'camera', 'the camera slot is untouched');
    assert.equal(popped.notify.length, 1);
    assert.deepEqual(
      { ...popped.notify[0], id: undefined, at: undefined },
      {
        kind: 'sms',
        id: undefined,
        numbers: ['+15065550100'],
        text: plea,
        at: undefined,
      },
    );
    assert.deepEqual(popped.release, {
      until: extended.until,
      incident: 'fire',
      watching: 0,
    });
    // Offline, the plea still names where the phone is, in coordinates.
    script(() => null);
    clock.tick(60_000);
    await post('/release', { standDown: true });
    await post('/release', { incident: 'medical' });
    await poll(Date.now());
    assert.equal(
      (await request('/status')).json().release.plea,
      'Please HELP you are close by, to 45.2700, -66.0600 of victim in progress, medical thank you.',
    );
    // STAND DOWN clears the file and is idempotent.
    const down = await post('/release', { standDown: true });
    assert.equal(down.json().release, null);
    assert.deepEqual(down.json().releases, []);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8')).releases,
      [],
    );
    assert.equal(
      (await post('/release', { standDown: true })).json().release,
      null,
    );
    // Four hours and a second later the window is over, with no write.
    await post('/release', { incident: 'threat' });
    const writes = hardened.length;
    clock.tick(14_400_001);
    assert.equal((await request('/status')).json().release, null);
    assert.equal(hardened.length, writes, 'an expired release writes nothing');
    const preview = harness(plugin, { preview: true });
    const refused = await preview('/release', {
      method: 'POST',
      headers: PAGE,
      body: { incident: 'fire' },
    });
    assert.equal(refused.status, 403);
    assert.equal(
      refused.json().error,
      'Editing is available under the dev server only',
    );
  } finally {
    clock.restore();
  }
});

test('a restart reloads an active release and drops an expired one', async () => {
  const { post, file, restart } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    await post('/release', { incident: 'fire' });
    const back = (await restart().request('/status')).json().release;
    assert.deepEqual(
      [back.lat, back.lon, back.incident],
      [45.27, -66.06, 'fire'],
    );
    clock.tick(14_400_001);
    assert.equal((await restart().request('/status')).json().release, null);
    assert.equal(
      JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8')).releases
        .length,
      1,
      'the file keeps it until the next write drops it',
    );
  } finally {
    clock.restore();
  }
});

test('after a full restart the SMS line says it does not know, never SENDING', async () => {
  await withEnv(TWILIO, async () => {
    const { post, request, script, poll, restart } = setup();
    const clock = withClock(Date.UTC(2026, 8, 28, 18));
    try {
      script((url) => {
        if (url.startsWith('https://nominatim')) return SAINT_JOHN;
        if (url === TWILIO_URL)
          return { status: 201, body: JSON.stringify({ sid: 'SM1' }) };
        return null;
      });
      await post('/contacts', {
        label: 'Neighbour',
        number: '+15065550100',
        kind: 'other',
      });
      noteUltraPosition({
        key: VAN_KEY,
        name: 'Van 7',
        lat: 45.27,
        lon: -66.06,
        at: Date.now(),
      });
      assert.equal((await post('/release', { incident: 'fire' })).status, 200);
      await poll(Date.now());
      await flush();
      assert.match(
        (await request('/status')).json().release.sms.outcome,
        /^SMS SENT \d\d:\d\d$/,
      );
      // npm run dev stopped and started half an hour later: the call comes
      // back from the file, what its texts did (memory only) does not.
      clock.tick(30 * 60_000);
      const back = restart();
      assert.deepEqual((await back.request('/status')).json().release.sms, {
        outcome: 'SMS: NOT KNOWN SINCE RESTART',
        sent: 0,
        failed: 0,
      });
      // EXTEND HELP makes a fresh record, and the line knows again.
      assert.equal(
        (await back.post('/release', { incident: 'fire' })).status,
        200,
      );
      await poll(Date.now());
      await flush();
      assert.match(
        (await back.request('/status')).json().release.sms.outcome,
        /^SMS SENT \d\d:\d\d$/,
      );
    } finally {
      clock.restore();
    }
  });
});

// ---- the holder's subscription --------------------------------------------

test('holder /network: two shapes only, and NETWORK off is a 404 that is not a miss', async () => {
  const { post, request, file } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    const on = (await mint(post, { label: 'Sam', network: true })).revealed;
    const off = (await mint(post, { label: 'Courier' })).revealed;
    const ask = (token, options = {}) => net(token, options);
    const quiet = await ask(on.token);
    assert.equal(quiet.status, 200);
    assert.equal(
      quiet.headers['Content-Security-Policy'],
      "default-src 'none'",
    );
    assert.equal(quiet.headers['Cache-Control'], 'no-store, private');
    assert.equal(quiet.headers['Referrer-Policy'], 'no-referrer');
    assert.deepEqual(quiet.json(), { released: false });
    // A token minted without the flag, and a record written by hand with no
    // field at all, both answer the uniform 404 and spend no miss budget.
    assert.equal((await ask(off.token)).status, 404);
    const store = JSON.parse(
      fs.readFileSync(file('ultra-tokens.json'), 'utf8'),
    );
    delete store.tokens[1].network;
    fs.writeFileSync(file('ultra-tokens.json'), JSON.stringify(store, null, 2));
    for (let i = 0; i < 20; i += 1) {
      const answer = await ask(off.token, { remoteAddress: '100.99.9.9' });
      assert.deepEqual(
        [answer.status, answer.text],
        [404, 'Not found'],
        `network-off ${i + 1}`,
      );
    }
    assert.equal(
      (await phone(UNKNOWN, { remoteAddress: '100.99.9.9' })).status,
      404,
      'the miss budget was never spent, so a first real miss is still served',
    );
    assert.equal(
      (await ask(on.token, { remoteAddress: '100.99.9.9' })).status,
      200,
    );
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    const sent = (await post('/release', { incident: 'fire' })).json().release;
    const answer = await ask(on.token);
    assert.deepEqual(Object.keys(answer.json()), [
      'released',
      'name',
      'lat',
      'lon',
      'at',
      'until',
      'incident',
    ]);
    assert.deepEqual(answer.json(), {
      released: true,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: sent.at,
      until: sent.until,
      incident: 'fire',
    });
    // The name the owner chose for the network wins over the package's.
    await post('/network', { me: true, name: '  Jeff  ' });
    assert.equal((await ask(on.token)).json().name, 'Jeff');
    // A newer fix moves the served position and the time it last changed.
    clock.tick(30_000);
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.3,
      lon: -66.1,
      at: Date.now(),
    });
    const moved = (await ask(on.token)).json();
    assert.deepEqual(
      [moved.lat, moved.lon, moved.at],
      [45.3, -66.1, Date.now()],
    );
    // Who is watching, and for how long that counts.
    const status = (await request('/status')).json();
    assert.deepEqual(
      [status.tokens[0].network, status.tokens[1].network],
      [true, false],
    );
    assert.equal(status.tokens[0].watchedAt, Date.now());
    assert.deepEqual([status.release.holders, status.release.watching], [1, 1]);
    clock.tick(60_001);
    assert.equal((await request('/status')).json().release.watching, 0);
    // NETWORK ON flips the other; REVOKE, STAND DOWN and expiry all stop it.
    await post('/tokens', { edit: true, id: off.id, network: true });
    assert.equal((await ask(off.token)).json().released, true);
    await post('/tokens', { revoke: true, id: off.id });
    assert.equal((await ask(off.token)).status, 404);
    await post('/release', { standDown: true });
    assert.deepEqual((await ask(on.token)).json(), { released: false });
    await post('/release', { incident: 'fire' });
    assert.equal((await ask(on.token)).json().released, true);
    // While the call is on, the token still has no status route.
    const none = await phone(`/ultra/help/${on.token}/status`);
    assert.deepEqual([none.status, none.text], [404, 'Not found']);
    clock.tick(14_400_001);
    assert.deepEqual((await ask(on.token)).json(), { released: false });
    // POST on the path is the uniform 404.
    assert.equal(
      (
        await net(on.token, {
          method: 'POST',
          headers: JSON_BODY,
          body: {},
        })
      ).status,
      404,
    );
    // The address budget is the one every holder route shares.
    for (let i = 0; i < 60; i += 1)
      assert.equal(
        (await ask(on.token, { remoteAddress: '100.88.8.8' })).status,
        200,
        `request ${i + 1}`,
      );
    const flooded = await ask(on.token, { remoteAddress: '100.88.8.8' });
    assert.deepEqual([flooded.status, flooded.text], [429, 'Wait']);
  } finally {
    clock.restore();
  }
});

// ---- SEND HELP from the phone ---------------------------------------------

test('phone /help: under the paired key alone, budgeted, and the poll carries the window', async () => {
  const { post, request, file } = setup({ feeds: [VAN, HOME] });
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const help = (body, options = {}) =>
    phone(`/ultra/${VAN_KEY}/help`, {
      method: 'POST',
      headers: JSON_BODY,
      body,
      ...options,
    });
  try {
    const plainReq = fakeRequest(`/ultra/${VAN_KEY}/help`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      remoteAddress: HOLDER,
      body: '{}',
    });
    const plain = await phoneWith(plainReq, `/ultra/${VAN_KEY}/help`);
    assert.deepEqual([plain.status, plain.text], [415, 'Send JSON']);
    assert.equal(plainReq.readableDidRead, false, 'refused before the body');
    const big = await help({ note: 'x'.repeat(5000) });
    assert.deepEqual([big.status, big.text], [413, 'Too large']);
    const junk = await help('{');
    assert.deepEqual([junk.status, junk.text], [400, 'Send JSON']);
    const blind = await help({});
    assert.equal(blind.status, 409);
    assert.equal(
      blind.text,
      'No position yet: allow location for this page, then try again',
    );
    const sent = await help({
      lat: 45.3,
      lon: -66.1,
      accuracy: 8,
      incident: 'medical',
    });
    assert.equal(sent.status, 200, sent.text);
    assert.deepEqual(Object.keys(sent.json()), ['ok', 'release']);
    assert.deepEqual(sent.json().release, {
      until: Date.now() + 14_400_000,
      incident: 'medical',
      watching: 0,
    });
    const status = (await request('/status')).json();
    assert.deepEqual(
      [status.position.lat, status.position.lon],
      [45.3, -66.1],
      'the fix the phone sent is where the package is now',
    );
    assert.equal(status.release.feedId, 'security-van');
    assert.equal(
      JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8')).releases[0]
        .incident,
      'medical',
    );
    // The phone's own poll shows the window; the other package's does not.
    assert.deepEqual((await phone(`/ultra/${VAN_KEY}`)).json().release, {
      until: Date.now() + 14_400_000,
      incident: 'medical',
      watching: 0,
    });
    assert.equal((await phone(`/ultra/${HOME_KEY}`)).json().release, null);
    const down = await help({ standDown: true });
    assert.deepEqual(down.json(), { ok: true, release: null });
    assert.equal((await request('/status')).json().release, null);
    // Six a minute per key, spent by every try whatever its answer: those
    // six are gone, so the seventh waits.
    const capped = await help({ standDown: true });
    assert.deepEqual([capped.status, capped.text], [429, 'Wait']);
    clock.tick(60_001);
    assert.equal((await help({ standDown: true })).status, 200);
    // A help token in the key slot is not a key.
    const token = (await mint(post, { label: 'Sam', feedId: 'security-van' }))
      .revealed.token;
    assert.equal(
      (
        await phone(`/ultra/${token}/help`, {
          method: 'POST',
          headers: JSON_BODY,
          body: {},
        })
      ).status,
      404,
    );
  } finally {
    clock.restore();
  }
});

test('the phone page carries SEND HELP, STAND DOWN and the helper card, and no link', async () => {
  const { post } = setup();
  const token = (await mint(post, { label: 'Sam', network: true })).revealed
    .token;
  const page = await phone(`/ultra/${VAN_KEY}/cam`);
  assert.equal(page.status, 200);
  for (const pin of [
    'id="sendHelp"',
    'id="standDown"',
    'id="helpKind"',
    '>SEND HELP<',
    '>STAND DOWN<',
    'TAP AGAIN TO SEND HELP',
    "root + '/help'",
    'body.release',
    'SEND SMS TO ',
    "body.command.kind === 'sms'",
    '[300, 120, 300, 120, 600]',
    '[500, 150, 500, 150, 900]',
    '[200, 80, 200]',
  ])
    assert.ok(page.text.includes(pin), pin);
  assert.ok(
    page.text.indexOf('body.notify.forEach(show)') <
      page.text.indexOf('body.command.kind'),
    'a call for help is shown before a camera switch',
  );
  assert.doesNotMatch(page.text, /innerHTML/);
  assert.ok(!page.text.includes(token) && !page.text.includes('uht1.'));
  // STAND DOWN is always on the page, and nothing in it hides the button.
  assert.doesNotMatch(page.text, /id="standDown"[^>]*hidden/);
  assert.doesNotMatch(page.text, /standDown\.hidden/);
});

test('the phone page keeps STAND DOWN with no call on, and a tap there ends nothing and says so', async () => {
  setup();
  const until = Date.now() + 4 * 3_600_000;
  let release = null;
  const page = await phonePage((url) => {
    if (url.endsWith('/help')) return { ok: true, release: null };
    if (url.startsWith('/?')) return {};
    return { command: null, notify: [], release };
  });
  await page.poll();
  assert.equal(page.byId.get('standDown').hidden, false);
  await page.click('standDown');
  const sent = page.posted.filter((item) => String(item.url).endsWith('/help'));
  assert.deepEqual(
    sent.map((item) => item.body),
    [{ standDown: true }],
  );
  assert.match(
    page.byId.get('helpState').textContent,
    /^Stood down .+\. Nothing is sent to your network now\.$/,
  );
  assert.equal(page.byId.get('sendHelp').textContent, 'SEND HELP');
  // A call started and ended from the box leaves the button where it is.
  release = { until, incident: 'fire', watching: 0 };
  await page.poll();
  assert.equal(page.byId.get('sendHelp').textContent, 'EXTEND HELP');
  release = null;
  await page.poll();
  assert.equal(page.byId.get('sendHelp').textContent, 'SEND HELP');
  assert.equal(page.byId.get('standDown').hidden, false);
});

// ---- one call per package, fresh positions --------------------------------

test('each package has its own call: a second package pressing SEND HELP never ends the first', async () => {
  const { post, request, file, restart } = setup({ feeds: [VAN, HOME] });
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const help = (key, body) =>
    phone(`/ultra/${key}/help`, { method: 'POST', headers: JSON_BODY, body });
  try {
    const van = (
      await mint(post, {
        label: 'Sam',
        network: true,
        anytime: false,
        feedId: 'security-van',
      })
    ).revealed.token;
    const home = (
      await mint(post, {
        label: 'Ann',
        network: true,
        anytime: false,
        feedId: 'security-home',
      })
    ).revealed.token;
    const first = await help(VAN_KEY, {
      lat: 45.27,
      lon: -66.06,
      incident: 'threat',
    });
    assert.equal(first.status, 200, first.text);
    clock.tick(30_000);
    const second = await help(HOME_KEY, {
      lat: 45.3,
      lon: -66.1,
      incident: 'fire',
    });
    assert.equal(second.status, 200, second.text);
    // Van 7's holders still see Van 7's call, and its phone stays on it.
    const vanAnswer = (await net(van)).json();
    assert.deepEqual(
      [vanAnswer.released, vanAnswer.lat, vanAnswer.incident],
      [true, 45.27, 'threat'],
    );
    assert.equal(
      (await phone(`/ultra/${VAN_KEY}`)).json().release.incident,
      'threat',
    );
    assert.equal((await net(home)).json().incident, 'fire');
    const both = (await request('/status')).json();
    assert.deepEqual(
      both.releases.map((item) => [item.feedId, item.name, item.incident]),
      [
        ['security-van', 'Van 7', 'threat'],
        ['security-home', 'Home', 'fire'],
      ],
    );
    assert.equal(both.release.feedId, 'security-home', 'the newest press');
    assert.equal(
      JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8')).releases
        .length,
      2,
    );
    // Home standing down ends Home's call and no other.
    assert.equal((await help(HOME_KEY, { standDown: true })).status, 200);
    assert.deepEqual((await net(home)).json(), { released: false });
    assert.equal((await net(van)).json().released, true);
    assert.equal((await phone(`/ultra/${HOME_KEY}`)).json().release, null);
    // A restart brings back the call still on, and only that one.
    const back = (await restart().request('/status')).json();
    assert.deepEqual(
      back.releases.map((item) => item.feedId),
      ['security-van'],
    );
  } finally {
    clock.restore();
  }
});

test('removing a package ends its call; a store that cannot be read ends nothing and still shows it', async () => {
  const { root, post, request } = setup({ feeds: [VAN, HOME] });
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const help = (key, body) =>
    phone(`/ultra/${key}/help`, { method: 'POST', headers: JSON_BODY, body });
  try {
    const van = (
      await mint(post, {
        label: 'Sam',
        network: true,
        anytime: false,
        feedId: 'security-van',
      })
    ).revealed.token;
    await help(VAN_KEY, {
      lat: 45.27,
      lon: -66.06,
      age: 0,
      incident: 'threat',
    });
    await help(HOME_KEY, { lat: 45.3, lon: -66.1, age: 0, incident: 'fire' });
    // The device store cannot be read for a moment: nothing ends, and both
    // calls stay in the box, marked, where STAND DOWN reaches them.
    fs.writeFileSync(path.join(root, DEVICE_FEED_STORE), '{ "feeds": [');
    const unreadable = (await request('/status')).json();
    assert.deepEqual(
      unreadable.releases.map((item) => [item.feedId, item.removed]),
      [
        ['security-van', true],
        ['security-home', true],
      ],
    );
    // Van 7 is removed on purpose: its call ends, Home's does not.
    writeFeeds(root, [HOME]);
    const after = (await request('/status')).json();
    assert.deepEqual(
      after.releases.map((item) => item.feedId),
      ['security-home'],
    );
    // Saved again under the same id, it does not bring the old call back.
    writeFeeds(root, [VAN, HOME]);
    assert.deepEqual((await net(van)).json(), {
      released: false,
    });
    assert.equal((await phone(`/ultra/${VAN_KEY}`)).json().release, null);
    // With the store unreadable again and one call on, a STAND DOWN that
    // names no package ends that call.
    fs.writeFileSync(path.join(root, DEVICE_FEED_STORE), 'not json');
    const down = await post('/release', { standDown: true });
    assert.equal(down.status, 200, down.text);
    assert.deepEqual(down.json().releases, []);
  } finally {
    clock.restore();
  }
});

test('position times: a report with no time or a future time is held as now, a saved report by its own fix time', async () => {
  const { root, post, request, restart } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    // No time at all, and zero: now, never 1970.
    for (const at of [undefined, null, 0]) {
      noteUltraPosition({
        key: VAN_KEY,
        name: 'Van 7',
        lat: 45.27,
        lon: -66.06,
        at,
      });
      assert.equal((await request('/status')).json().position.at, Date.now());
    }
    // A device clock two hours ahead: held as now, so the next honest fix
    // is not shut out and the release never carries a time from the future.
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now() + 2 * 3_600_000,
    });
    assert.equal((await request('/status')).json().position.at, Date.now());
    // A tracker's late batch: the report arrived a minute ago, but the fix in
    // it is three hours old. After a restart the saved report is dated by
    // the fix, so SEND HELP refuses it.
    const folder = path.join(root, DEVICE_RECORDING_DIR, 'security-van');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'last-report.json'),
      JSON.stringify({
        position: { lat: 44.65, lon: -63.57, at: Date.now() - 3 * 3_600_000 },
        at: Date.now() - 60_000,
      }),
    );
    const again = restart();
    const status = (await again.request('/status')).json();
    assert.equal(status.position.at, Date.now() - 3 * 3_600_000);
    const refused = await again.post('/release', { incident: 'fire' });
    assert.equal(refused.status, 409);
    assert.match(refused.json().error, /3 hours old/);
    void post;
  } finally {
    clock.restore();
  }
});

test('a phone page from before the age was sent cannot pass an old fix off as new', async () => {
  const { request } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const help = (body) =>
    phone(`/ultra/${VAN_KEY}/help`, {
      method: 'POST',
      headers: JSON_BODY,
      body,
    });
  try {
    // The page reported this fix with its time an hour ago…
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now() - 3_600_000,
    });
    // …and presses with it now, saying nothing of its age: refused.
    const old = await help({ lat: 45.27, lon: -66.06, incident: 'threat' });
    assert.equal(old.status, 409);
    assert.match(old.text, /60 minutes old/);
    assert.equal((await request('/status')).json().release, null);
    // A fresh fix reported by the page, then the same press: sent.
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.28,
      lon: -66.07,
      at: Date.now(),
    });
    const sent = await help({ lat: 45.28, lon: -66.07, incident: 'threat' });
    assert.equal(sent.status, 200, sent.text);
  } finally {
    clock.restore();
  }
});

test('EXTEND HELP after a restart renews the running call even before the phone reports again', async () => {
  const { post, restart } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    await post('/release', { incident: 'threat' });
    clock.tick(30 * 60_000);
    const again = restart();
    const phoneExtend = await phone(`/ultra/${VAN_KEY}/help`, {
      method: 'POST',
      headers: JSON_BODY,
      body: { lat: null, lon: null, incident: 'threat' },
    });
    assert.equal(phoneExtend.status, 200, phoneExtend.text);
    const deskExtend = await again.post('/release', { incident: 'threat' });
    assert.equal(deskExtend.status, 200, deskExtend.text);
    assert.deepEqual(
      [deskExtend.json().release.lat, deskExtend.json().release.renewedAt],
      [45.27, Date.now()],
    );
  } finally {
    clock.restore();
  }
});

test('a file from before one call per package still loads its call, and the next write moves it', async () => {
  const { post, request, file } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    fs.writeFileSync(
      file('ultra-help.json'),
      JSON.stringify({
        version: 1,
        contacts: [],
        owner: { number: '' },
        release: {
          at: Date.now() - 60_000,
          until: Date.now() + 3_600_000,
          lat: 45.27,
          lon: -66.06,
          fixAt: Date.now() - 60_000,
          feedId: 'security-van',
          incident: 'fire',
        },
      }),
    );
    const status = (await request('/status')).json();
    assert.deepEqual(
      [status.release.feedId, status.release.renewedAt],
      ['security-van', Date.now() - 60_000],
    );
    await post('/model', { modelId: 'google-pixel' });
    const saved = JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8'));
    assert.equal('release' in saved, false);
    assert.deepEqual(
      saved.releases.map((item) => item.feedId),
      ['security-van'],
    );
  } finally {
    clock.restore();
  }
});

test('the box acts on the package it names, never on whichever phone reported last', async () => {
  const { post } = setup({ feeds: [VAN, HOME] });
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const fix = (key, name, lat, lon) =>
    noteUltraPosition({ key, name, lat, lon, at: Date.now() });
  try {
    fix(VAN_KEY, 'Van 7', 45.27, -66.06);
    clock.tick(5000);
    fix(HOME_KEY, 'Home', 45.3, -66.1);
    // Two packages and no call running: the box has to say which.
    const vague = await post('/release', { incident: 'threat' });
    assert.deepEqual(
      [vague.status, vague.json().error],
      [400, 'Choose which package is asking for help'],
    );
    const sent = await post('/release', {
      incident: 'threat',
      feedId: 'security-van',
    });
    assert.equal(sent.status, 200, sent.text);
    assert.deepEqual(
      [sent.json().release.feedId, sent.json().release.lat],
      ['security-van', 45.27],
      "Van 7's own position, although Home reported last",
    );
    // Home reports again; EXTEND HELP on Van 7 still renews Van 7's call.
    clock.tick(60_000);
    fix(HOME_KEY, 'Home', 45.31, -66.11);
    const extended = (
      await post('/release', { incident: 'threat', feedId: 'security-van' })
    ).json();
    assert.deepEqual(
      extended.releases.map((item) => [item.feedId, item.at, item.lat]),
      [['security-van', sent.json().release.at, 45.27]],
    );
    // One call running and no package named (a page from before this): it
    // renews that call.
    const implicit = (await post('/release', { incident: 'threat' })).json();
    assert.deepEqual(
      implicit.releases.map((item) => item.feedId),
      ['security-van'],
    );
    // Two calls running: STAND DOWN has to name one, and ends only that one.
    await post('/release', { incident: 'fire', feedId: 'security-home' });
    const vagueDown = await post('/release', { standDown: true });
    assert.deepEqual(
      [vagueDown.status, vagueDown.json().error],
      [400, 'Choose which package to stand down'],
    );
    const down = (
      await post('/release', { standDown: true, feedId: 'security-home' })
    ).json();
    assert.deepEqual(
      down.releases.map((item) => item.feedId),
      ['security-van'],
    );
    // A package that is not saved is refused.
    const ghost = await post('/release', {
      incident: 'fire',
      feedId: 'security-gone',
    });
    assert.deepEqual(
      [ghost.status, ghost.json().error],
      [400, 'That Ultra Security Package is not saved any more'],
    );
  } finally {
    clock.restore();
  }
});

test('SEND HELP never publishes an old position as current, and EXTEND keeps a running call on', async () => {
  const { post, request } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const help = (body) =>
    phone(`/ultra/${VAN_KEY}/help`, {
      method: 'POST',
      headers: JSON_BODY,
      body,
    });
  try {
    const holder = (
      await mint(post, { label: 'Sam', network: true, anytime: false })
    ).revealed.token;
    // The phone last reported yesterday.
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now() - 26 * 3_600_000,
    });
    const desk = await post('/release', { incident: 'threat' });
    assert.equal(desk.status, 409);
    assert.match(
      desk.json().error,
      /^The phone's last position is 26 hours old/,
    );
    const blind = await help({ lat: null, lon: null, incident: 'threat' });
    assert.equal(blind.status, 409);
    assert.match(
      blind.text,
      /^No fresh position: the last one is 26 hours old/,
    );
    // A page that sends a fix says how old it is, and an old one is refused too.
    const old = await help({
      lat: 45.3,
      lon: -66.1,
      age: 25 * 60_000,
      incident: 'threat',
    });
    assert.equal(old.status, 409);
    assert.match(old.text, /25 minutes old/);
    assert.equal((await request('/status')).json().release, null);
    assert.deepEqual(
      (await net(holder)).json(),
      { released: false },
      'nothing was published',
    );
    // A fix four seconds old goes out, stamped with its own time.
    const sent = await help({
      lat: 45.3,
      lon: -66.1,
      age: 4000,
      incident: 'threat',
    });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(
      (await request('/status')).json().release.fixAt,
      Date.now() - 4000,
    );
    // Twenty-five minutes on with no new fix, EXTEND HELP still renews the
    // call, and holders are told it changed now, so no receiver reads it as
    // four hours stale while it is still on.
    clock.tick(25 * 60_000);
    const extended = await post('/release', { incident: 'threat' });
    assert.equal(extended.status, 200, extended.text);
    assert.equal(extended.json().release.renewedAt, Date.now());
    const served = (await net(holder)).json();
    assert.deepEqual(
      [served.released, served.lat, served.at],
      [true, 45.3, Date.now()],
    );
    assert.equal(
      (await help({ lat: null, lon: null, incident: 'threat' })).status,
      200,
      'the phone can extend its running call without a new fix',
    );
  } finally {
    clock.restore();
  }
});

/**
 * The phone page's own script, run against a minimal page: enough elements,
 * a location service, a voice and a vibrator that record what they are
 * asked for, and a fetch the test answers (an answer that throws is a fetch
 * that fails). Timers never fire by themselves; the test calls the
 * one-second poll when it wants one. A case can open the page at another
 * spelling of its address, or give it an older browser's AbortSignal.
 */
async function phonePage(
  answer,
  {
    pathname = `/ultra/${VAN_KEY}/cam`,
    AbortSignal: Signal = AbortSignal,
    AbortController: Controller = AbortController,
  } = {},
) {
  const served = await phone(pathname);
  assert.equal(served.status, 200, pathname);
  const html = served.text;
  const script = html.slice(
    html.indexOf('<script>') + '<script>'.length,
    html.indexOf('</script>'),
  );
  const spoken = [];
  const buzzed = [];
  const posted = [];
  // What the page stopped: speechSynthesis.cancel() and navigator.vibrate(0).
  const stopped = { speech: 0, buzz: 0 };
  const listeners = new Map();
  const intervals = new Map();
  const byId = new Map();
  const element = (id = '', parent = null) => {
    const node = {
      id,
      parent,
      textContent: '',
      hidden: false,
      disabled: false,
      value: '',
      href: '',
      title: '',
      className: '',
      children: [],
      handlers: new Map(),
      addEventListener(type, fn) {
        node.handlers.set(type, [...(node.handlers.get(type) || []), fn]);
      },
      closest(selector) {
        for (let at = node; at; at = at.parent)
          if (selector === `#${at.id}`) return at;
        return null;
      },
      append(...kids) {
        for (const kid of kids) {
          kid.parent = node;
          node.children.push(kid);
        }
      },
      prepend(kid) {
        kid.parent = node;
        node.children.unshift(kid);
      },
      remove() {
        if (!node.parent) return;
        node.parent.children = node.parent.children.filter((k) => k !== node);
      },
      get lastChild() {
        return node.children[node.children.length - 1];
      },
    };
    return node;
  };
  const helpRow = element('helpRow');
  for (const id of ['helpKind', 'sendHelp', 'standDown'])
    byId.set(id, element(id, helpRow));
  byId.set('helpRow', helpRow);
  for (const id of [
    'status',
    'view',
    'gps',
    'inbox',
    'notices',
    'sound',
    'soundRow',
    'helpState',
    'file',
  ])
    byId.set(id, element(id));
  byId.get('helpKind').value = 'threat';
  // The location service: a press's own request when one is waiting, else
  // the page's standing watch, so a test can hand the page a fix any time.
  let locate = null;
  let watch = null;
  const context = {
    console,
    AbortSignal: Signal,
    AbortController: Controller,
    URLSearchParams,
    location: { pathname },
    document: {
      title: '',
      getElementById: (id) => byId.get(id) || null,
      createElement: () => element(),
      addEventListener(type, fn) {
        listeners.set(type, [...(listeners.get(type) || []), fn]);
      },
    },
    navigator: {
      geolocation: {
        watchPosition(ok) {
          watch = ok;
        },
        getCurrentPosition(ok) {
          locate = ok;
        },
      },
      vibrate: (pattern) =>
        pattern === 0 ? (stopped.buzz += 1) : buzzed.push(pattern),
    },
    isSecureContext: false,
    speechSynthesis: {
      speak: (u) => u.text && spoken.push(u.text),
      cancel: () => {
        stopped.speech += 1;
      },
    },
    SpeechSynthesisUtterance: function Utterance(text) {
      this.text = text;
    },
    setInterval: (fn, ms) => intervals.set(ms, fn),
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url, init = {}) => {
      posted.push({
        url,
        body: init.body ? JSON.parse(init.body) : null,
        signal: init.signal,
      });
      const body = answer(url, init);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    },
  };
  context.window = context;
  const vm = await import('node:vm');
  vm.runInNewContext(script, context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const click = async (id) => {
    const target = byId.get(id);
    for (const fn of target.handlers.get('click') || []) await fn({ target });
    for (const fn of listeners.get('click') || []) fn({ target });
    for (let i = 0; i < 5; i += 1) await settle();
  };
  const poll = async () => {
    await intervals.get(1000)();
    for (let i = 0; i < 3; i += 1) await settle();
  };
  // A poll whose answer is still out: the caller settles it later.
  const startPoll = () => intervals.get(1000)();
  return {
    spoken,
    buzzed,
    posted,
    stopped,
    click,
    poll,
    startPoll,
    settle,
    byId,
    locate: (lat, lon) => {
      const ok = locate || watch;
      locate = null;
      ok?.({
        coords: { latitude: lat, longitude: lon, accuracy: 8 },
        timestamp: Date.now(),
      });
    },
  };
}

test('the phone asking for help stays silent, and still for a THREAT', async () => {
  setup();
  const until = Date.now() + 4 * 3_600_000;
  let poll = { command: null, notify: [], release: null };
  const page = await phonePage((url) => {
    if (url.endsWith('/help'))
      return { ok: true, release: { until, incident: 'threat', watching: 1 } };
    if (url.startsWith('/?')) return {};
    return poll;
  });
  // Two taps on SEND HELP, with no fix yet: the page asks for one, then sends
  // it with its age. The taps never switch the voice on.
  await page.click('sendHelp');
  const second = page.click('sendHelp');
  await new Promise((resolve) => setImmediate(resolve));
  page.locate(45.27, -66.06);
  await second;
  const press = page.posted.find((item) => String(item.url).endsWith('/help'));
  assert.deepEqual(
    [press.body.lat, press.body.lon, press.body.incident],
    [45.27, -66.06, 'threat'],
  );
  assert.ok(press.body.age >= 0 && press.body.age < 1000);
  assert.deepEqual(page.buzzed, [], 'no confirming buzz for a THREAT');
  assert.ok(page.stopped.speech >= 1, 'the committed tap silenced the voice');
  assert.ok(page.stopped.buzz >= 1, 'and stopped any vibration, for a THREAT');
  // The helper card and a holder's message arrive: shown, never spoken or buzzed.
  poll = {
    command: null,
    release: { until, incident: 'threat', watching: 1 },
    notify: [
      {
        kind: 'sms',
        numbers: ['+15065550100'],
        text: 'Please HELP you are close by',
      },
      {
        kind: 'message',
        from: 'Sam',
        label: 'Neighbour',
        text: 'where are you',
        at: Date.now(),
      },
    ],
  };
  await page.poll();
  assert.equal(page.byId.get('notices').children.length, 2, 'both cards show');
  // Even with Sound on pressed on purpose, nothing is said during the call.
  await page.click('sound');
  poll = {
    ...poll,
    notify: [{ kind: 'message', from: 'Ann', label: 'x', text: 'on my way' }],
  };
  await page.poll();
  assert.deepEqual(page.spoken, []);
  assert.deepEqual(page.buzzed, []);
  // After STAND DOWN the page talks and buzzes again.
  poll = {
    command: null,
    release: null,
    notify: [{ kind: 'message', from: 'Ann', label: 'x', text: 'safe now?' }],
  };
  await page.poll();
  assert.equal(page.spoken.length, 1);
  assert.match(page.spoken[0], /safe now\?/);
  assert.equal(page.buzzed.length, 1);
});

test('the phone asking for MEDICAL help buzzes for a card but still never talks', async () => {
  setup();
  const until = Date.now() + 4 * 3_600_000;
  const page = await phonePage(() => ({
    command: null,
    release: { until, incident: 'medical', watching: 0 },
    notify: [{ kind: 'message', from: 'Sam', label: 'x', text: 'coming' }],
  }));
  // A tap anywhere but the SEND HELP row arms the voice, as it always did.
  await page.click('status');
  await page.poll();
  assert.deepEqual(page.spoken, []);
  assert.equal(page.buzzed.length, 1);
});

test('a call started elsewhere silences the phone at once, and EXTEND keeps its incident', async () => {
  setup();
  const until = Date.now() + 4 * 3_600_000;
  let poll = {
    command: null,
    release: null,
    notify: [
      { kind: 'release', from: 'Ann', text: 'Ann needs help', at: Date.now() },
    ],
  };
  const page = await phonePage((url) =>
    url.endsWith('/help')
      ? { ok: true, release: { until, incident: 'threat', watching: 0 } }
      : url.startsWith('/?')
        ? {}
        : poll,
  );
  // The page opens on OTHER, the owner taps the page (sound on) and hears Ann.
  page.byId.get('helpKind').value = 'other';
  await page.click('status');
  await page.poll();
  assert.equal(page.spoken.length, 1);
  // The owner's THREAT call is started from the box: the next poll carries it.
  // The phone stops talking and buzzing at once, and shows THREAT.
  poll = {
    command: null,
    release: { until, incident: 'threat', watching: 0 },
    notify: [],
  };
  await page.poll();
  assert.equal(page.stopped.speech, 1);
  assert.equal(page.stopped.buzz, 1);
  assert.equal(page.byId.get('helpKind').value, 'threat');
  const buzzesBefore = page.buzzed.length;
  // Two taps on EXTEND HELP renew the THREAT call, not an OTHER one.
  page.locate(45.27, -66.06);
  await page.click('sendHelp');
  await page.click('sendHelp');
  const press = page.posted
    .filter((item) => String(item.url).endsWith('/help'))
    .pop();
  assert.equal(press.body.incident, 'threat');
  assert.equal(page.buzzed.length, buzzesBefore, 'no buzz during the call');
  // A deliberate change on the page is sent as chosen.
  page.byId.get('helpKind').value = 'medical';
  for (const fn of page.byId.get('helpKind').handlers.get('change') || []) fn();
  await page.poll();
  assert.equal(page.byId.get('helpKind').value, 'medical', 'the poll keeps it');
});

test('a STAND DOWN tapped while the phone is being found wins over the press', async () => {
  setup();
  const until = Date.now() + 4 * 3_600_000;
  const page = await phonePage((url) => {
    if (url.endsWith('/help')) return { ok: true, release: null };
    if (url.startsWith('/?')) return {};
    return {
      command: null,
      notify: [],
      release: { until, incident: 'fire', watching: 0 },
    };
  });
  await page.poll();
  // EXTEND: the first tap arms, the second starts finding the phone…
  await page.click('sendHelp');
  const second = page.click('sendHelp');
  await page.settle();
  assert.equal(page.byId.get('sendHelp').textContent, 'FINDING THIS PHONE…');
  // …and STAND DOWN is tapped before a fix comes.
  await page.click('standDown');
  page.locate(45.27, -66.06);
  await second;
  const sent = page.posted.filter((item) => String(item.url).endsWith('/help'));
  assert.deepEqual(
    sent.map((item) => item.body),
    [{ standDown: true }],
    'the stand-down went, the press did not',
  );
});

test('a poll sent before the press was answered cannot undo it, and the clocks never decide the call', async () => {
  setup();
  let release = null;
  let hold = null;
  const page = await phonePage((url) => {
    if (url.endsWith('/help'))
      return {
        ok: true,
        // The box's clock is well behind this phone's: by the phone, the
        // window it reports has already ended.
        release: {
          until: Date.now() - 60_000,
          incident: 'threat',
          watching: 0,
        },
      };
    if (url.startsWith('/?')) return {};
    if (hold) return hold.promise;
    return { command: null, notify: [], release };
  });
  // A poll goes out and is slow to come back…
  let answer;
  hold = { promise: new Promise((resolve) => (answer = resolve)) };
  const slow = page.startPoll();
  hold = null;
  // …the press is sent and answered meanwhile…
  page.locate(45.27, -66.06);
  await page.click('sendHelp');
  await page.click('sendHelp');
  assert.equal(page.byId.get('sendHelp').textContent, 'EXTEND HELP');
  // …then the slow answer lands, from before the press: no call, and a
  // message that would have been spoken.
  answer({
    command: null,
    release: null,
    notify: [{ kind: 'message', from: 'Sam', label: 'x', text: 'hello' }],
  });
  await slow;
  for (let i = 0; i < 3; i += 1) await page.settle();
  assert.equal(
    page.byId.get('sendHelp').textContent,
    'EXTEND HELP',
    'still on',
  );
  assert.deepEqual(page.spoken, []);
  assert.deepEqual(page.buzzed, []);
  // Later polls carry the call: whatever this phone's clock says, it is on.
  release = { until: Date.now() - 60_000, incident: 'threat', watching: 0 };
  await page.click('status');
  await page.poll();
  assert.deepEqual(page.spoken, []);
  assert.equal(page.byId.get('sendHelp').textContent, 'EXTEND HELP');
});

test('a phone browser without AbortSignal.timeout still sends SEND HELP, and a timeout there says so', async () => {
  setup();
  const until = Date.now() + 4 * 3_600_000;
  let stalled = false;
  const answer = (url) => {
    if (url.endsWith('/help')) {
      // What a controller's abort() makes a fetch reject with.
      if (stalled)
        throw Object.assign(new Error('The operation was aborted.'), {
          name: 'AbortError',
        });
      return { ok: true, release: { until, incident: 'other', watching: 1 } };
    }
    if (url.startsWith('/?')) return {};
    return { command: null, notify: [], release: null };
  };
  // A browser from before 2022: AbortSignal is there, its timeout() is not.
  const page = await phonePage(answer, { AbortSignal: class {} });
  page.locate(45.27, -66.06);
  await page.click('sendHelp');
  await page.click('sendHelp');
  const presses = page.posted.filter((item) =>
    String(item.url).endsWith('/help'),
  );
  assert.equal(presses.length, 1, 'the press reached the map');
  assert.equal(
    typeof presses[0].signal?.aborted,
    'boolean',
    'still bounded, by a controller',
  );
  const helpState = page.byId.get('helpState');
  assert.match(helpState.textContent, /^HELP SENT /);
  // A controller's timeout reads as one, not as no connection, and leaves
  // the button free to press again.
  stalled = true;
  await page.click('sendHelp');
  await page.click('sendHelp');
  assert.equal(
    helpState.textContent,
    'No answer in 15 seconds — press again to retry (is Tailscale on?)',
  );
  assert.equal(page.byId.get('sendHelp').disabled, false);
  // A current browser whose press times out says the same.
  const current = await phonePage(answer);
  current.locate(45.27, -66.06);
  await current.click('sendHelp');
  await current.click('sendHelp');
  assert.match(
    current.byId.get('helpState').textContent,
    /^No answer in 15 seconds/,
  );
});

test('the phone page opened with a trailing slash still polls and sends help under its key', async () => {
  setup();
  const until = Date.now() + 4 * 3_600_000;
  for (const pathname of [
    `/ultra/${VAN_KEY}/cam/`,
    `/ultra//${VAN_KEY}//cam`,
  ]) {
    const page = await phonePage(
      (url) => {
        if (url.endsWith('/help'))
          return {
            ok: true,
            release: { until, incident: 'fire', watching: 1 },
          };
        if (url.startsWith('/?')) return {};
        return { command: null, notify: [], release: null };
      },
      { pathname },
    );
    await page.poll();
    page.locate(45.27, -66.06);
    await page.click('sendHelp');
    await page.click('sendHelp');
    const urls = page.posted.map((item) => String(item.url));
    assert.deepEqual(
      urls.filter((url) => !url.startsWith('/?')),
      [`/ultra/${VAN_KEY}`, `/ultra/${VAN_KEY}/help`],
      pathname,
    );
    assert.ok(
      urls.some((url) => url.startsWith(`/?id=${VAN_KEY}&`)),
      'the position goes under the key too',
    );
    assert.match(
      page.byId.get('helpState').textContent,
      /^HELP SENT /,
      pathname,
    );
  }
});

test('the phone page keeps the plea card on screen through a burst of messages', async () => {
  setup();
  const plea = {
    kind: 'sms',
    numbers: ['+15065550100'],
    text: 'Please HELP you are close by',
  };
  const note = (text) => ({
    kind: 'message',
    from: 'Sam',
    label: 'Neighbour',
    text,
    at: Date.now(),
  });
  // What the map's queue hands over after a burst: the plea card is the
  // oldest, so it comes first and ends up at the bottom of the list.
  let poll = {
    command: null,
    release: null,
    notify: [
      plea,
      ...Array.from({ length: 19 }, (_, i) => note(`message ${i + 1}`)),
    ],
  };
  const page = await phonePage(() => poll);
  await page.poll();
  const notices = page.byId.get('notices');
  const heads = () => notices.children.map((li) => li.children[0].textContent);
  const bodies = () => notices.children.map((li) => li.children[1].textContent);
  assert.equal(notices.children.length, 10);
  assert.deepEqual(
    heads().filter((head) => head.startsWith('SEND SMS TO')),
    ['SEND SMS TO 1 HELPER'],
    'the plea card is still on screen',
  );
  assert.deepEqual(bodies().slice(0, 9), [
    'message 19',
    'message 18',
    'message 17',
    'message 16',
    'message 15',
    'message 14',
    'message 13',
    'message 12',
    'message 11',
  ]);
  // With nothing but SMS cards on screen, a new message still gets its card:
  // the one just shown is never the one that goes.
  poll = {
    command: null,
    release: null,
    notify: [
      ...Array.from({ length: 10 }, (_, i) => ({
        ...plea,
        text: `Find Ultra Help ${i + 1}`,
      })),
      note('on my way'),
    ],
  };
  await page.poll();
  assert.equal(notices.children.length, 10);
  assert.equal(bodies()[0], 'on my way');
});

test('the phone page keeps only the newest plea through an EXTENDed call, and a stood-down plea ages out', async () => {
  setup();
  const call = {
    until: Date.now() + 14_400_000,
    incident: 'medical',
    watching: 2,
  };
  const plea = (text) => ({ kind: 'sms', numbers: ['+15065550100'], text });
  const note = (text) => ({
    kind: 'message',
    from: 'Sam',
    label: 'Neighbour',
    text,
    at: Date.now(),
  });
  // Each poll hands over what the test sets next, once.
  let next = { command: null, release: call, notify: [] };
  const page = await phonePage(() => {
    const answer = next;
    next = { ...next, notify: [] };
    return answer;
  });
  const pollWith = async (release, ...notify) => {
    next = { command: null, release, notify };
    await page.poll();
  };
  const notices = page.byId.get('notices');
  const bodies = () => notices.children.map((li) => li.children[1].textContent);
  const pleas = () =>
    notices.children
      .filter((li) => li.children[0].textContent.startsWith('SEND SMS TO'))
      .map((li) => li.children[1].textContent);
  // SEND HELP, then nine EXTENDs: the phone pops each plea within a second.
  for (let i = 1; i <= 10; i += 1)
    await pollWith(call, plea(`Please HELP ${i}`));
  assert.equal(pleas().length, 10);
  // The helpers' messages push the older pleas out, not one another.
  for (let i = 1; i <= 4; i += 1) await pollWith(call, note(`message ${i}`));
  assert.deepEqual(bodies().slice(0, 5), [
    'message 4',
    'message 3',
    'message 2',
    'message 1',
    'Please HELP 10',
  ]);
  // The newest plea stays through any burst while the call is on.
  for (let i = 5; i <= 20; i += 1) await pollWith(call, note(`message ${i}`));
  assert.deepEqual(pleas(), ['Please HELP 10']);
  assert.equal(bodies()[0], 'message 20');
  // STAND DOWN: the plea stays for now, then ages out like any card (it is
  // the oldest here), so the page no longer offers to text the helpers
  // about a call that is over.
  await pollWith(null);
  assert.deepEqual(pleas(), ['Please HELP 10']);
  for (let i = 1; i <= 10; i += 1) await pollWith(null, note(`after ${i}`));
  assert.deepEqual(pleas(), []);
  assert.equal(notices.children.length, 10);
  // A Find Ultra Help text sent with no call on keeps its place through a
  // burst: the call-off that unmarks a plea is the change, not every poll.
  await pollWith(null, plea('Fire at 12 Main St'));
  for (let i = 1; i <= 12; i += 1) await pollWith(null, note(`later ${i}`));
  assert.deepEqual(pleas(), ['Fire at 12 Main St']);
  assert.equal(bodies()[0], 'later 12');
});

// ---- the home list --------------------------------------------------------

test('home list: only tailnet links, sealed, deduplicated, and never in an answer', async () => {
  const { post, request, file, hardened } = setup();
  noteUltraEndpoint(['https://me.tail9.ts.net']);
  const added = await post('/network', {
    add: true,
    address: PEER_ADDRESS,
    token: PEER_TOKEN,
    name: 'Sam',
  });
  assert.equal(added.status, 200, added.text);
  const [entry] = added.json().network.entries;
  assert.deepEqual(
    [entry.name, entry.host, entry.source, entry.lastState, entry.active],
    ['Sam', 'peer.tail9.ts.net', 'manual', 'new', false],
  );
  assert.match(entry.id, /^n-[0-9a-f]{16}$/);
  assert.ok(!('base' in entry) && !('hash' in entry) && !('sealed' in entry));
  assert.ok(
    !added.text.includes('uht1.') && !added.text.includes(PEER_LINK),
    'no token and no link is ever answered',
  );
  const saved = fs.readFileSync(file('ultra-network.json'), 'utf8');
  assert.ok(
    !saved.includes(PEER_TOKEN),
    'the file holds a hash and ciphertext',
  );
  const stored = JSON.parse(saved);
  assert.match(stored.entries[0].hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(stored.entries[0].sealed), [
    'v',
    'iv',
    'tag',
    'data',
  ]);
  assert.ok(fs.existsSync(file('ultra-tokens.key')), 'the key was made for it');
  assert.ok(
    hardened.some(
      (call) =>
        call.size === 0 &&
        /^\.ultra-network\.json\.[0-9a-f]{8}\.tmp$/.test(call.file),
    ),
    'the home list goes through the credential-store path',
  );
  const refuse = async (body, status, message) => {
    const answer = await post('/network', { add: true, ...body });
    assert.equal(answer.status, status, answer.text);
    assert.equal(answer.json().error, message);
  };
  const NOT_TAILNET =
    'That address is not an https .ts.net address or a 100.64.x tailnet address, so it will not be polled';
  const ENTER_BOTH =
    'Enter their tailnet address (https://….ts.net) and their Ultra Token (uht1.…)';
  for (const address of [
    'https://box.local',
    'http://192.168.1.9',
    'http://127.0.0.1:44173',
    'https://evil.example',
    'http://peer.tail9.ts.net',
  ])
    await refuse({ address, token: PEER_TOKEN }, 400, NOT_TAILNET);
  // Both fields, each whole: a token alone, an address alone, a short token,
  // an address with a path, and the old joined link in the address box.
  for (const body of [
    { token: PEER_TOKEN },
    { address: PEER_ADDRESS },
    { address: PEER_ADDRESS, token: PEER_TOKEN.slice(0, -1) },
    { address: PEER_ADDRESS, token: PEER_TOKEN + ' ' + OTHER_TOKEN },
    { address: `${PEER_ADDRESS}/ultra/help/`, token: PEER_TOKEN },
    { address: PEER_LINK, token: PEER_TOKEN },
    { address: PEER_LINK },
    { address: PEER_LINK, token: '' },
    { address: 'peer.tail9.ts.net', token: PEER_TOKEN },
    {},
  ])
    await refuse(body, 400, ENTER_BOTH);
  // A body that joins the two into a link is refused whole, whatever else
  // it carries: the server never reads a joined link.
  for (const body of [
    { link: PEER_LINK },
    { link: PEER_LINK, name: 'Sam' },
    { link: PEER_LINK, address: ANN_ADDRESS, token: ANN_TOKEN },
    { link: '', address: ANN_ADDRESS, token: ANN_TOKEN },
    { link: null, address: ANN_ADDRESS, token: ANN_TOKEN },
  ])
    await refuse(body, 400, ENTER_BOTH);
  assert.equal(
    (await request('/status')).json().network.entries.length,
    1,
    'nothing was added by any refused body',
  );
  await refuse(
    { address: PEER_ADDRESS, token: PEER_TOKEN },
    409,
    'Already in your home list',
  );
  await refuse(
    { address: 'https://other.tail9.ts.net', token: PEER_TOKEN },
    409,
    'Already in your home list',
  );
  const mine = (await mint(post, { label: 'Me', network: true })).revealed;
  const OWN = 'That is your own tailnet address or Ultra Token';
  await refuse({ address: mine.address, token: mine.token }, 409, OWN);
  await refuse({ address: ANN_ADDRESS, token: mine.token }, 409, OWN);
  await refuse(
    {
      address: 'https://me.tail9.ts.net',
      token: `${PEER_TOKEN.slice(0, -1)}B`,
    },
    409,
    OWN,
  );
  // An http address to a 100.64.x literal is the other reachable shape.
  const literal = await post('/network', {
    add: true,
    address: 'http://100.100.1.9',
    token: OTHER_TOKEN,
  });
  assert.equal(literal.status, 200, literal.text);
  assert.equal(literal.json().network.entries[1].name, '100.100.1.9');
  // Rename, then remove; a bad id is not found either way.
  assert.equal(
    (await post('/network', { rename: true, id: entry.id, name: ' ' })).json()
      .error,
    'Name who this link belongs to',
  );
  const renamed = await post('/network', {
    rename: true,
    id: entry.id,
    name: 'Sam next door',
  });
  assert.equal(renamed.json().network.entries[0].name, 'Sam next door');
  assert.equal(
    (
      await post('/network', {
        rename: true,
        id: 'n-0000000000000000',
        name: 'X',
      })
    ).status,
    404,
  );
  assert.equal(
    (await post('/network', { me: true, name: '  Jeff  ' })).json().network.me
      .name,
    'Jeff',
  );
  // The key is what opens the list: without it nothing can be polled.
  fs.rmSync(file('ultra-tokens.key'));
  const noKey = (await request('/status')).json().network;
  assert.equal(noKey.keyState, 'no-key');
  assert.deepEqual(
    noKey.entries.map((row) => row.lastState),
    ['no-key', 'no-key'],
  );
  const removed = await post('/network', { remove: true, id: entry.id });
  assert.equal(removed.json().network.entries.length, 1);
  assert.equal(
    (await post('/network', { remove: true, id: entry.id })).status,
    404,
  );
  assert.equal(
    (await post('/network', { nonsense: true })).json().error,
    'Say me, add, remove, rename, update, publish, poll or testSms',
  );
  // RESET TOKENS empties the list and keeps the owner's own name.
  const reset = await post('/tokens', { reset: true, confirm: true });
  assert.equal(reset.status, 200, reset.text);
  assert.deepEqual(reset.json().network.entries, []);
  assert.equal(reset.json().network.me.name, 'Jeff');
});

test('the home list is read-only under a preview build, and never polled there', async () => {
  const { plugin } = setup();
  const preview = harness(plugin, { preview: true });
  for (const body of [
    { me: true, name: 'Jeff' },
    { add: true, address: PEER_ADDRESS, token: PEER_TOKEN },
    { remove: true, id: 'n-0000000000000000' },
    { rename: true, id: 'n-0000000000000000', name: 'X' },
    { update: true },
    { publish: true },
    { poll: true },
    { testSms: true },
  ]) {
    const answer = await preview('/network', {
      method: 'POST',
      headers: PAGE,
      body,
    });
    assert.equal(answer.status, 403, JSON.stringify(body));
    assert.equal(
      answer.json().error,
      'Editing is available under the dev server only',
    );
  }
  assert.equal((await preview('/status')).json().network.polling, false);
});

// ---- the poller -----------------------------------------------------------

/** One home-list entry and a scripted peer, on a frozen clock. */
async function withPeer(run, { feeds = [VAN] } = {}) {
  const world = setup({ feeds });
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    noteUltraEndpoint(['https://me.tail9.ts.net']);
    const added = await world.post('/network', {
      add: true,
      address: PEER_ADDRESS,
      token: PEER_TOKEN,
      name: 'Sam',
    });
    assert.equal(added.status, 200, added.text);
    await run({ ...world, clock, entry: added.json().network.entries[0] });
  } finally {
    clock.restore();
  }
}

const releasedBody = (over = {}) =>
  json({
    released: true,
    name: 'Van 7',
    lat: 45.27,
    lon: -66.06,
    at: Date.now() - 5000,
    until: Date.now() + 14_395_000,
    incident: 'fire',
    ...over,
  });

test('poller: two tokens from one address poll one URL by their own bearers, and a revoked one leaves the other polling', async () => {
  await withPeer(async ({ post, request, script, calls, poll, clock }) => {
    // Sam handed out a second token for the same machine (another phone of
    // his, or a replacement for the first): same address, another token.
    const added = await post('/network', {
      add: true,
      address: PEER_ADDRESS,
      token: OTHER_TOKEN,
      name: 'Sam (second)',
    });
    assert.equal(added.status, 200, added.text);
    let revoked = false;
    script((url, asked) => {
      if (url !== PEER_NETWORK) return null;
      const sent = bearerOf(asked);
      if (sent === `Bearer ${PEER_TOKEN}`)
        return revoked
          ? { status: 404, body: 'Not found' }
          : json({ released: false });
      if (sent === `Bearer ${OTHER_TOKEN}`) return json({ released: false });
      return { status: 404, body: 'Not found' };
    });
    const states = async () =>
      Object.fromEntries(
        (await request('/status'))
          .json()
          .network.entries.map((row) => [row.name, row.lastState]),
      );
    await poll(Date.now());
    const polls = calls.filter((call) => call.url === PEER_NETWORK);
    assert.equal(polls.length, 2, 'both entries polled');
    assert.deepEqual(
      polls.map(bearerOf).sort(),
      [`Bearer ${OTHER_TOKEN}`, `Bearer ${PEER_TOKEN}`].sort(),
      'each by its own bearer',
    );
    assert.ok(
      polls.every((call) => call.url === `${PEER_ADDRESS}/ultra/help/network`),
      'one URL for both, with no token in it',
    );
    assert.deepEqual(await states(), { Sam: 'quiet', 'Sam (second)': 'quiet' });
    // Sam revokes the first token: that entry alone goes dead; the second
    // polls on, on its twenty-second cadence.
    revoked = true;
    clock.tick(20_001);
    await poll(Date.now());
    assert.deepEqual(await states(), { Sam: 'dead', 'Sam (second)': 'quiet' });
    const before = calls.filter((call) => call.url === PEER_NETWORK).length;
    clock.tick(20_001);
    await poll(Date.now());
    const since = calls
      .filter((call) => call.url === PEER_NETWORK)
      .slice(before);
    assert.deepEqual(since.map(bearerOf), [`Bearer ${OTHER_TOKEN}`]);
    assert.deepEqual(await states(), { Sam: 'dead', 'Sam (second)': 'quiet' });
  });
});

test('poller: one episode per call for help, geocoded once, pinned, never duplicated', async () => {
  await withPeer(
    async ({ request, script, calls, poll, pins, clock, entry }) => {
      noteUltraPosition({
        key: VAN_KEY,
        name: 'Van 7',
        lat: 45.2,
        lon: -66,
        at: Date.now(),
      });
      let peer = () => releasedBody();
      let address = SAINT_JOHN;
      script((url) => {
        if (url === PEER_NETWORK) return peer();
        if (url.startsWith('https://nominatim')) return address;
        return null;
      });
      const logged = [];
      const log = console.log;
      console.log = (...args) => logged.push(args.map(String).join(' '));
      try {
        await poll(Date.now());
      } finally {
        console.log = log;
      }
      const asked = calls.find((call) => call.url === PEER_NETWORK);
      assert.deepEqual(
        [asked.method, asked.redirect, typeof asked.signal],
        ['GET', 'error', 'object'],
      );
      // The peer's own token rides the Authorization header, and nothing
      // else does; the URL names the address and the fixed route alone.
      assert.equal(bearerOf(asked), `Bearer ${PEER_TOKEN}`);
      assert.ok(!('Cookie' in asked.headers), 'no cookie ever reaches a peer');
      assert.equal(asked.url, `${PEER_ADDRESS}/ultra/help/network`);
      assert.ok(!asked.url.includes('uht1.'), 'the token is never in the URL');
      const status = (await request('/status')).json();
      assert.deepEqual(
        [status.network.entries[0].lastState, status.network.entries[0].active],
        ['released', true],
      );
      assert.equal(status.unread, 1);
      const [row] = status.inbox;
      const plea = `Please HELP you are close by, to ${PLACE} of victim in progress, fire thank you.`;
      assert.deepEqual(
        {
          kind: row.kind,
          label: row.label,
          from: row.from,
          number: row.number,
          place: row.place,
          incident: row.incident,
          text: row.text,
          active: row.active,
          networkId: row.networkId,
          tokenId: row.tokenId,
          until: row.until,
        },
        {
          kind: 'release',
          label: 'Sam',
          from: 'Van 7',
          number: '',
          place: PLACE,
          incident: 'fire',
          text: plea,
          active: true,
          networkId: entry.id,
          tokenId: '',
          // What was left on their clock, re-based on this machine's.
          until: Date.now() + 14_400_000,
        },
      );
      assert.ok(
        row.distanceKm > 0 && row.distanceKm < 20,
        String(row.distanceKm),
      );
      // The phone gets exactly one card, and the map one amber pin.
      const popped = (await phone(`/ultra/${VAN_KEY}`)).json();
      assert.equal(popped.notify.length, 1);
      assert.deepEqual(
        { ...popped.notify[0], id: undefined },
        {
          kind: 'release',
          id: undefined,
          label: 'Sam',
          from: 'Van 7',
          number: '',
          lat: 45.27,
          lon: -66.06,
          text: plea,
          place: PLACE,
          incident: 'fire',
          at: row.at,
          until: row.until,
          networkId: entry.id,
        },
      );
      const [pin] = pins(Date.now());
      assert.deepEqual(
        [pin.id, pin.kind, pin.follow, pin.record, pin.live, pin.color],
        [`ultra-network:${entry.id}`, 'help', false, false, true, '#ffb000'],
      );
      assert.match(pin.kindLabel, /^NEEDS HELP · \d\d:\d\d$/);
      // Nothing is said but the entry's own id.
      assert.ok(logged.length >= 1);
      for (const line of logged) {
        assert.ok(line.includes(entry.id), line);
        assert.ok(
          !line.includes('peer.tail9.ts.net') &&
            !line.includes('uht1.') &&
            !line.includes('Van 7') &&
            !line.includes('45.27') &&
            !line.includes('Example St'),
          line,
        );
      }
      // Before nextAt nothing is asked again.
      const before = calls.length;
      await poll(Date.now());
      assert.equal(calls.length, before, 'the twenty-second cadence holds');
      // Ten metres keeps the address; a hundred asks once more.
      const geocodes = () =>
        calls.filter((call) => call.url.startsWith('https://nominatim')).length;
      clock.tick(20_001);
      peer = () => releasedBody({ lat: 45.2701, lon: -66.06 });
      await poll(Date.now());
      assert.equal(geocodes(), 1, 'ten metres is not a new address');
      assert.equal((await request('/status')).json().inbox[0].lat, 45.2701);
      clock.tick(20_001);
      peer = () => releasedBody({ lat: 45.272, lon: -66.06 });
      address = json({
        address: {
          road: 'Union St',
          city: 'Saint John',
          state: 'New Brunswick',
        },
        display_name: 'Union St',
      });
      await poll(Date.now());
      const moved = (await request('/status')).json();
      assert.equal(geocodes(), 2);
      assert.match(moved.inbox[0].place, /^Union St, Saint John/);
      assert.equal(moved.inbox.length, 1, 'still one row');
      assert.deepEqual(
        (await phone(`/ultra/${VAN_KEY}`)).json().notify,
        [],
        'a move is no new card',
      );
      // Stood down: the row ends and the pin goes.
      clock.tick(20_001);
      peer = () => json({ released: false });
      await poll(Date.now());
      const ended = (await request('/status')).json();
      assert.deepEqual(
        [ended.network.entries[0].lastState, ended.network.entries[0].active],
        ['quiet', false],
      );
      assert.equal(ended.inbox[0].active, false);
      assert.ok(ended.inbox[0].until <= Date.now());
      assert.deepEqual(pins(Date.now()), []);
      // Inside ten minutes the same row comes back; past them a new one opens.
      clock.tick(20_001);
      peer = () => releasedBody();
      await poll(Date.now());
      assert.equal((await request('/status')).json().inbox.length, 1);
      clock.tick(20_001);
      peer = () => json({ released: false });
      await poll(Date.now());
      clock.tick(600_001);
      peer = () => releasedBody();
      await poll(Date.now());
      assert.equal((await request('/status')).json().inbox.length, 2);
    },
  );
});

test('poller: a peer moving on every poll holds one place in the geocode lane, not one a poll', async () => {
  await withPeer(async ({ request, script, calls, poll, clock }) => {
    let step = 0;
    let answerLookups;
    const held = new Promise((resolve) => {
      answerLookups = resolve;
    });
    script(async (url) => {
      if (url === PEER_NETWORK)
        return releasedBody({ lat: 45.27 + step * 0.002 });
      if (url.startsWith('https://nominatim')) {
        await held;
        return SAINT_JOHN;
      }
      return null;
    });
    const lookups = () =>
      calls.filter((call) => call.url.startsWith('https://nominatim')).length;
    // Four polls, about 220 m apart, while Nominatim is slow to answer the
    // first lookup: the later positions do not queue lookups of their own.
    const polls = [];
    for (step = 0; step < 4; step += 1) {
      polls.push(poll(Date.now()));
      await flush();
      clock.tick(20_001);
    }
    answerLookups();
    await Promise.all(polls);
    assert.equal(lookups(), 1);
    // The first poll after that lookup landed looks up where the peer is now.
    await poll(Date.now());
    assert.equal(lookups(), 2);
    const [row] = (await request('/status')).json().inbox;
    assert.equal(
      row.place,
      '10 Example St, Saint John, New Brunswick (45.2780, -66.0600)',
    );
  });
});

test('poller: a street lookup that lands after the peer moved on never takes the row back to where it was', async () => {
  await withPeer(async ({ request, script, poll, pins, clock }) => {
    let step = 0;
    let reachable = true;
    let answerLookups;
    const held = new Promise((resolve) => {
      answerLookups = resolve;
    });
    script(async (url) => {
      if (url === PEER_NETWORK)
        return reachable ? releasedBody({ lat: 45.27 + step * 0.002 }) : null;
      if (url.startsWith('https://nominatim')) {
        await held;
        return SAINT_JOHN;
      }
      return null;
    });
    const row = async () => (await request('/status')).json().inbox[0];
    // Four polls about 220 m apart while the first lookup waits its turn.
    const polls = [];
    for (step = 0; step < 4; step += 1) {
      polls.push(poll(Date.now()));
      await flush();
      clock.tick(20_001);
    }
    const last = 45.27 + 3 * 0.002;
    assert.equal((await row()).lat, last);
    // The peer drops off the tailnet, and only then does the lookup land:
    // it was for the first spot, 670 m back.
    reachable = false;
    const warn = console.warn;
    console.warn = () => {};
    try {
      answerLookups();
      await Promise.all(polls);
      const landed = await row();
      assert.deepEqual(
        [landed.lat, landed.active, landed.place],
        [last, true, '45.2760, -66.0600'],
        'the newest position stays, and no street of the old spot is put on it',
      );
      assert.deepEqual(
        pins(Date.now()).map((pin) => pin.lat),
        [last],
      );
      // Nothing puts it right while the peer is unreachable, so it must
      // already be right: five minutes on, the same spot.
      for (let i = 0; i < 5; i += 1) {
        clock.tick(60_001);
        await poll(Date.now());
      }
      const later = await row();
      assert.deepEqual([later.lat, later.active], [last, true]);
      assert.deepEqual(
        pins(Date.now()).map((pin) => pin.lat),
        [last],
      );
    } finally {
      console.warn = warn;
    }
  });
});

test('poller: a street lookup still waiting its turn when the server moves to another checkout never goes out there', async () => {
  const nominatim = (list) =>
    list.filter((call) => call.url.startsWith('https://nominatim')).length;
  let other = null;
  await withPeer(async ({ post, script, calls, poll }) => {
    const added = await post('/network', {
      add: true,
      address: ANN_ADDRESS,
      token: ANN_TOKEN,
      name: 'Ann',
    });
    assert.equal(added.status, 200, added.text);
    script((url) => {
      if (url.endsWith('/network')) return releasedBody();
      if (url.startsWith('https://nominatim')) return SAINT_JOHN;
      return null;
    });
    // Two calls for help in one round: the first lookup goes at once and
    // the second waits its second in the one-a-second lane.
    const polling = poll(Date.now());
    for (let turn = 0; turn < 50 && nominatim(calls) < 1; turn += 1)
      await flush();
    assert.equal(nominatim(calls), 1);
    // What pointing the module at another checkout does (as the tests do
    // between cases): the waiting lookup belongs to the old one.
    other = setup();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await polling;
    assert.equal(nominatim(calls), 1, 'nor through the old checkout');
  });
  assert.equal(nominatim(other.calls), 0);
});

test('poller: a dead, busy, unreachable or lying peer only ever slows itself down', async () => {
  await withPeer(async ({ request, post, script, calls, poll, clock }) => {
    let peer = () => ({ status: 404, body: 'Not found' });
    script((url) => (url === PEER_NETWORK ? peer() : null));
    const state = async () =>
      (await request('/status')).json().network.entries[0].lastState;
    await poll(Date.now());
    assert.equal(await state(), 'dead');
    let seen = calls.length;
    const checked = await post('/network', { poll: true });
    assert.equal(checked.json().polling, true);
    assert.equal(calls.length, seen + 1, 'CHECK NOW asks whatever the wait');
    seen = calls.length;
    clock.tick(599_000);
    await poll(Date.now());
    assert.equal(calls.length, seen, 'a dead link is retried in ten minutes');
    clock.tick(2000);
    peer = () => ({ status: 429, body: 'Wait' });
    await poll(Date.now());
    assert.equal(await state(), 'busy');
    clock.tick(60_001);
    peer = () => ({ throws: 'refused' });
    await poll(Date.now());
    assert.equal(await state(), 'unreachable');
    seen = calls.length;
    clock.tick(19_000);
    await poll(Date.now());
    assert.equal(calls.length, seen, 'twenty seconds after the first failure');
    clock.tick(1001);
    await poll(Date.now());
    assert.equal(calls.length, seen + 1);
    clock.tick(39_000);
    await poll(Date.now());
    assert.equal(calls.length, seen + 1, 'then forty');
    clock.tick(1001);
    await poll(Date.now());
    assert.equal(calls.length, seen + 2);
    // A flood of bytes, a lie about the shape, a string for a number and a
    // status nobody expects are all simply unreadable.
    for (const body of [
      { status: 200, body: 'x'.repeat(10_000) },
      json({ released: 'yes' }),
      { status: 500, body: 'no' },
      { status: 200, body: 'not json' },
    ]) {
      clock.tick(600_001);
      peer = () => body;
      await poll(Date.now());
      assert.equal(
        await state(),
        'unreachable',
        JSON.stringify(body).slice(0, 40),
      );
      assert.deepEqual((await request('/status')).json().inbox, []);
    }
    for (const body of [
      releasedBody({ lat: '45.27' }),
      releasedBody({ lat: 0, lon: 0 }),
      releasedBody({ at: Date.now() - 5 * 60 * 60 * 1000, until: Date.now() }),
      releasedBody({ until: Date.now() - 5 * 60 * 60 * 1000 }),
    ]) {
      clock.tick(600_001);
      peer = () => body;
      await poll(Date.now());
      assert.equal(await state(), 'quiet', 'a claim that does not hold up');
      assert.deepEqual((await request('/status')).json().inbox, []);
    }
  });
});

test('poller: four at a time, tailnet-only targets, and a restart that speaks to nobody', async () => {
  await withPeer(
    async ({ request, post, script, calls, poll, clock, restart, file }) => {
      script((url) =>
        url === PEER_NETWORK
          ? releasedBody()
          : url.startsWith('https://nominatim')
            ? SAINT_JOHN
            : url.includes('.ts.net')
              ? json({ released: false })
              : null,
      );
      // Twelve due entries, four requests.
      for (let i = 0; i < 11; i += 1) {
        const added = await post('/network', {
          add: true,
          address: `https://peer${i}.tail9.ts.net`,
          token: `uht1.${String(i).padStart(43, 'q')}`,
          name: `Peer ${i}`,
        });
        assert.equal(added.status, 200, added.text);
      }
      const polls = () =>
        calls.filter((call) => call.url.endsWith('/network')).length;
      const before = polls();
      await poll(Date.now());
      assert.equal(polls() - before, 4, 'four in flight, no more');
      // The peer that answered is the episode; a restart brings it back
      // without a second row, a second card or a second word.
      clock.tick(20_001);
      await poll(Date.now());
      const rows = (await request('/status')).json().inbox;
      assert.equal(rows.length, 1);
      await phone(`/ultra/${VAN_KEY}`);
      const world = restart();
      const back = (await world.request('/status')).json();
      assert.equal(back.inbox.length, 1);
      assert.equal(back.inbox[0].active, true, 'the episode came back active');
      assert.deepEqual(
        (await phone(`/ultra/${VAN_KEY}`)).json().notify,
        [],
        'a restart never speaks again',
      );
      clock.tick(20_001);
      await poll(Date.now());
      assert.equal((await world.request('/status')).json().inbox.length, 1);
      // A stored base that no longer matches its check is not fetched, and
      // the row says it was changed. The check is what stops the token going
      // out. A public name is a second stop, checked once the file has no
      // check at all, the way an older home list does.
      const store = JSON.parse(
        fs.readFileSync(file('ultra-network.json'), 'utf8'),
      );
      store.entries = [{ ...store.entries[0], base: 'https://evil.example' }];
      fs.writeFileSync(
        file('ultra-network.json'),
        JSON.stringify(store, null, 2),
      );
      const after = restart();
      const asked = calls.length;
      await poll(Date.now() + 1000);
      assert.equal(calls.length, asked, 'nothing is asked of a changed base');
      assert.equal(
        (await after.request('/status')).json().network.entries[0].lastState,
        'tampered',
      );
      delete store.entries[0].policyMac;
      fs.writeFileSync(
        file('ultra-network.json'),
        JSON.stringify(store, null, 2),
      );
      const plain = restart();
      const askedPlain = calls.length;
      await poll(Date.now() + 1000);
      assert.equal(
        calls.length,
        askedPlain,
        'nothing is asked of a public name',
      );
      assert.equal(
        (await plain.request('/status')).json().network.entries[0].lastState,
        'not-tailnet',
      );
    },
  );
});

test('poller: a call ends here when it ends on the peer’s clock, even after the peer drops off', async () => {
  await withPeer(async ({ request, script, poll, pins, clock }) => {
    // Pressed now, and the phone never reports again, so every answer
    // carries the press as its `at`; the peer's server stamps each answer
    // with its own clock, as node does.
    const pressed = Date.now();
    let reachable = true;
    script((url) => {
      if (url === PEER_NETWORK) {
        if (!reachable) return null;
        return {
          ...releasedBody({ at: pressed, until: pressed + 14_400_000 }),
          headers: {
            'content-type': 'application/json',
            date: new Date(Date.now()).toUTCString(),
          },
        };
      }
      return url.startsWith('https://nominatim') ? SAINT_JOHN : null;
    });
    const row = async () => (await request('/status')).json().inbox[0];
    clock.tick(60_000);
    await poll(Date.now());
    assert.equal((await row()).until, pressed + 14_400_000);
    // A minute before the end, still the same end.
    clock.tick(14_400_000 - 120_000);
    await poll(Date.now());
    assert.deepEqual(
      [(await row()).active, (await row()).until],
      [true, pressed + 14_400_000],
    );
    // Then the peer drops off the tailnet: the row ends when the call does,
    // not four hours after the press was last seen.
    reachable = false;
    for (const wait of [20_001, 60_000, 8_340_000]) {
      clock.tick(wait);
      await poll(Date.now());
    }
    assert.equal(
      (await request('/status')).json().network.entries[0].lastState,
      'unreachable',
    );
    assert.equal((await row()).active, false);
    assert.deepEqual(pins(Date.now()), []);
  });
});

test('poller: a REMOVE the disk refuses leaves the call it carries running, on the same row', async () => {
  await withPeer(
    async ({
      request,
      post,
      script,
      poll,
      pins,
      clock,
      refuseWrites,
      entry,
    }) => {
      script((url) =>
        url === PEER_NETWORK
          ? releasedBody()
          : url.startsWith('https://nominatim')
            ? SAINT_JOHN
            : null,
      );
      const logged = [];
      const log = console.log;
      console.log = (...args) => logged.push(args.map(String).join(' '));
      try {
        await poll(Date.now());
        const [first] = (await request('/status')).json().inbox;
        assert.equal(first.active, true);
        assert.equal(
          (await phone(`/ultra/${VAN_KEY}`)).json().notify.length,
          1,
        );
        refuseWrites(true);
        const removed = await post('/network', { remove: true, id: entry.id });
        assert.equal(removed.status, 409, removed.text);
        assert.match(removed.json().error, /^Not saved/);
        // Not removed, so nothing it carries has changed either.
        const kept = (await request('/status')).json();
        assert.deepEqual(
          kept.network.entries.map((row) => [row.id, row.active]),
          [[entry.id, true]],
        );
        assert.deepEqual(
          kept.inbox.map((row) => [row.id, row.active]),
          [[first.id, true]],
        );
        assert.equal(pins(Date.now()).length, 1);
        // The next poll carries on with the same row: no second row, no
        // second 'needs help', no second card.
        refuseWrites(false);
        clock.tick(20_001);
        await poll(Date.now());
        assert.deepEqual(
          (await request('/status'))
            .json()
            .inbox.map((row) => [row.id, row.active]),
          [[first.id, true]],
        );
        assert.equal(
          logged.filter((line) => line.endsWith(`${entry.id} needs help`))
            .length,
          1,
        );
        assert.deepEqual((await phone(`/ultra/${VAN_KEY}`)).json().notify, []);
        assert.equal(pins(Date.now()).length, 1);
      } finally {
        console.log = log;
      }
    },
  );
});

test('poller: two links to one person’s call raise one row; another package on that machine raises its own', async () => {
  const { post, request, script, poll, pins } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    noteUltraEndpoint(['https://me.tail9.ts.net']);
    // Alice's machine, reached three ways: her token handed over by hand,
    // the directory's token for the same package, and a token for her van.
    // All three poll one URL; the bearer tells them apart.
    const ALICE = 'https://alice.tail9.ts.net';
    const byHand = `uht1.${'Al1'.repeat(14)}A`;
    const listed = `uht1.${'Al2'.repeat(14)}B`;
    const van = `uht1.${'Al3'.repeat(14)}C`;
    for (const [name, token] of [
      ['Alice', byHand],
      ['Alice (directory)', listed],
      ['Alice van', van],
    ]) {
      const added = await post('/network', {
        add: true,
        address: ALICE,
        token,
        name,
      });
      assert.equal(added.status, 200, added.text);
    }
    let call = { at: Date.now() - 5000, until: Date.now() + 14_395_000 };
    let vanCall = null;
    script((url, asked) => {
      if (url === `${ALICE}/ultra/help/network`) {
        const sent = bearerOf(asked);
        if (sent === `Bearer ${byHand}` || sent === `Bearer ${listed}`)
          return releasedBody(call);
        if (sent === `Bearer ${van}`)
          return vanCall
            ? releasedBody({ ...vanCall, name: 'Van 9', lat: 45.3 })
            : json({ released: false });
        return { status: 404, body: 'Not found' };
      }
      return url.startsWith('https://nominatim') ? SAINT_JOHN : null;
    });
    const running = async () =>
      (await request('/status'))
        .json()
        .inbox.filter((row) => row.kind === 'release' && row.active);
    const cards = async () =>
      (await phone(`/ultra/${VAN_KEY}`))
        .json()
        .notify.filter((card) => card.kind === 'release');
    await poll(Date.now());
    assert.equal((await running()).length, 1, 'one call, one row');
    assert.equal(pins(Date.now()).length, 1);
    assert.equal((await cards()).length, 1);
    // EXTEND HELP moves the end on both links: still that one row.
    clock.tick(20_001);
    call = { at: Date.now() - 1000, until: Date.now() + 14_399_000 };
    await poll(Date.now());
    clock.tick(20_001);
    await poll(Date.now());
    assert.equal((await running()).length, 1, 'an EXTEND is the same call');
    assert.deepEqual(await cards(), []);
    // The van's own package asks for help: another person, another row.
    clock.tick(20_001);
    vanCall = { at: Date.now() - 2000, until: Date.now() + 14_398_000 };
    await poll(Date.now());
    const rows = await running();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.from).sort(), ['Van 7', 'Van 9']);
    assert.equal(pins(Date.now()).length, 2);
    assert.equal((await cards()).length, 1);
  } finally {
    clock.restore();
  }
});

/**
 * Alice's machine reached by two tokens to the same package: by hand, and
 * from the directory. Both poll one URL; `byHand(call)` and `listed(call)`
 * say which token a recorded fetch carried as its bearer.
 */
async function twoLinksToAlice(post) {
  noteUltraEndpoint(['https://me.tail9.ts.net']);
  const ALICE = 'https://alice.tail9.ts.net';
  const tokens = {
    byHand: `uht1.${'Al1'.repeat(14)}A`,
    listed: `uht1.${'Al2'.repeat(14)}B`,
  };
  for (const [name, token] of [
    ['Alice', tokens.byHand],
    ['Alice (directory)', tokens.listed],
  ]) {
    const added = await post('/network', {
      add: true,
      address: ALICE,
      token,
      name,
    });
    assert.equal(added.status, 200, added.text);
  }
  const at = (token) => (url, call) =>
    url === `${ALICE}/ultra/help/network` &&
    bearerOf(call) === `Bearer ${token}`;
  return {
    url: `${ALICE}/ultra/help/network`,
    byHand: at(tokens.byHand),
    listed: at(tokens.listed),
  };
}

test('poller: after a restart mid-call, the second link to that call raises nothing, whichever link answers first', async () => {
  const world = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const logged = [];
  const log = console.log;
  console.log = (...args) => logged.push(args.map(String).join(' '));
  try {
    const links = await twoLinksToAlice(world.post);
    let call = { at: Date.now() - 5000, until: Date.now() + 14_395_000 };
    // The link by hand is listed first, so it is asked first after a
    // restart; its answer can be held back so the other link is judged first.
    let gate = null;
    let revoked = false;
    world.script(async (url, asked) => {
      const byHand = links.byHand(url, asked);
      if (byHand && revoked) return { status: 404, body: 'Not found' };
      if (byHand || links.listed(url, asked)) {
        if (byHand && gate) await gate.promise;
        return releasedBody(call);
      }
      return url.startsWith('https://nominatim') ? SAINT_JOHN : null;
    });
    const hold = () => {
      let open;
      const promise = new Promise((resolve) => {
        open = resolve;
      });
      gate = { promise, open };
    };
    await world.poll(Date.now());
    const cards = async () =>
      (await phone(`/ultra/${VAN_KEY}`))
        .json()
        .notify.filter((card) => card.kind === 'release');
    assert.equal((await cards()).length, 1);
    const running = async (request) =>
      (await request('/status'))
        .json()
        .inbox.filter((row) => row.kind === 'release' && row.active)
        .map((row) => row.id);
    const [only] = await running(world.request);
    const needsHelp = () =>
      logged.filter((line) => line.endsWith('needs help')).length;
    assert.equal(needsHelp(), 1);
    // `npm run dev` restarts; on the first round the directory's link is
    // answered before the one that carries the row.
    for (const extended of [false, true]) {
      const back = world.restart();
      // The box opens: the home list is read, the row resumed, and both
      // links are due within the first second.
      assert.deepEqual(await running(back.request), [only]);
      clock.tick(1000);
      // …once with the call as it was, and once EXTENDed while this machine
      // was off, so its window end no longer matches the one the row kept.
      if (extended)
        call = { at: Date.now() - 1000, until: Date.now() + 14_399_000 };
      hold();
      const round = world.poll(Date.now());
      await flush(12);
      gate.open();
      await round;
      clock.tick(ULTRA_NETWORK_TICK_MS);
      await world.poll(Date.now());
      assert.deepEqual(
        await running(back.request),
        [only],
        `extended ${extended}`,
      );
      assert.deepEqual(await cards(), []);
      assert.equal(needsHelp(), 1);
      assert.equal(world.pins(Date.now()).length, 1);
      gate = null;
      clock.tick(20_001);
      await world.poll(Date.now());
      assert.deepEqual(await running(back.request), [only]);
    }
    // Once more, and this time the token that link uses was revoked while
    // this machine was off: it answers LINK DEAD, and the other link, which
    // still hears the call, takes the row over. Still one row, and silent.
    const back = world.restart();
    assert.deepEqual(await running(back.request), [only]);
    clock.tick(1000);
    revoked = true;
    await world.poll(Date.now());
    clock.tick(20_001);
    await world.poll(Date.now());
    assert.deepEqual(await running(back.request), [only]);
    assert.deepEqual(await cards(), []);
    assert.equal(needsHelp(), 1);
    assert.equal(world.pins(Date.now()).length, 1);
  } finally {
    console.log = log;
    clock.restore();
  }
});

test('poller: a link that stops hearing a call hands its row to the link that still does, so the row moves and ends with the call', async () => {
  const world = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    const links = await twoLinksToAlice(world.post);
    const call = { at: Date.now() - 5000, until: Date.now() + 14_395_000 };
    let lat = 45.27;
    let revoked = false;
    let stoodDown = false;
    world.script((url, asked) => {
      const byHand = links.byHand(url, asked);
      if (byHand && revoked) return { status: 404, body: 'Not found' };
      if (byHand || links.listed(url, asked))
        return stoodDown
          ? json({ released: false })
          : releasedBody({ ...call, lat });
      return url.startsWith('https://nominatim') ? SAINT_JOHN : null;
    });
    const rows = async () =>
      (await world.request('/status'))
        .json()
        .inbox.filter((row) => row.kind === 'release');
    const cards = async () =>
      (await phone(`/ultra/${VAN_KEY}`))
        .json()
        .notify.filter((card) => card.kind === 'release');
    // Both links heard the call; the one by hand carries the row.
    await world.poll(Date.now());
    const [first] = await rows();
    assert.equal(first.label, 'Alice');
    assert.equal((await cards()).length, 1);
    // Alice revokes that token mid-call and runs two kilometres.
    revoked = true;
    for (const step of [45.28, 45.285, 45.29]) {
      clock.tick(20_001);
      lat = step;
      await world.poll(Date.now());
    }
    const moving = await rows();
    assert.deepEqual(
      moving.map((row) => [row.id, row.active, row.lat]),
      [[first.id, true, 45.29]],
      'one row, where she is now',
    );
    assert.deepEqual(
      world.pins(Date.now()).map((pin) => pin.lat),
      [45.29],
    );
    assert.deepEqual(await cards(), [], 'the same call is no new card');
    // STAND DOWN, heard on the link that still works: the row ends.
    stoodDown = true;
    clock.tick(20_001);
    await world.poll(Date.now());
    const ended = await rows();
    assert.deepEqual(
      ended.map((row) => [row.id, row.active]),
      [[first.id, false]],
    );
    assert.deepEqual(world.pins(Date.now()), []);
  } finally {
    clock.restore();
  }
});

test('poller: a reverse geocode that failed is asked again a minute later, and the row gets the street', async () => {
  await withPeer(async ({ request, script, calls, poll, clock }) => {
    let address = { status: 503, body: 'busy' };
    script((url) =>
      url === PEER_NETWORK
        ? releasedBody()
        : url.startsWith('https://nominatim')
          ? address
          : null,
    );
    const geocodes = () =>
      calls.filter((call) => call.url.startsWith('https://nominatim')).length;
    const place = async () => (await request('/status')).json().inbox[0].place;
    const warn = console.warn;
    console.warn = () => {};
    try {
      await poll(Date.now());
    } finally {
      console.warn = warn;
    }
    assert.equal(await place(), '45.2700, -66.0600');
    assert.equal(geocodes(), 1);
    assert.equal(
      (await request('/status')).json().inbox[0].placing,
      false,
      'a lookup that failed is not waited for any more',
    );
    assert.equal((await phone(`/ultra/${VAN_KEY}`)).json().notify.length, 1);
    // Nominatim is back, but twenty seconds is too soon to ask again.
    address = SAINT_JOHN;
    clock.tick(20_001);
    await poll(Date.now());
    assert.equal(await place(), '45.2700, -66.0600');
    assert.equal(geocodes(), 1);
    // A minute after the failure it is asked again, and the row (and its
    // plea) read the street; the phone gets no second card for it.
    clock.tick(40_001);
    await poll(Date.now());
    assert.equal(geocodes(), 2);
    const [row] = (await request('/status')).json().inbox;
    assert.equal(row.place, PLACE);
    assert.ok(row.text.includes(PLACE), row.text);
    assert.deepEqual((await phone(`/ultra/${VAN_KEY}`)).json().notify, []);
  });
});

test('poller: a geocoder answer past a megabyte is a failed lookup, not read to the end', async () => {
  await withPeer(async ({ request, script, poll }) => {
    // Valid JSON naming a street, padded past the cap.
    const huge = json({
      address: { road: 'Planted Rd', city: 'Elsewhere', country_code: 'ca' },
      display_name: 'Planted Rd, Elsewhere',
      pad: 'x'.repeat(1024 * 1024 + 1),
    });
    script((url) =>
      url === PEER_NETWORK
        ? releasedBody()
        : url.startsWith('https://nominatim')
          ? huge
          : null,
    );
    const warned = [];
    const warn = console.warn;
    console.warn = (...args) => warned.push(args.map(String).join(' '));
    try {
      await poll(Date.now());
    } finally {
      console.warn = warn;
    }
    const [row] = (await request('/status')).json().inbox;
    assert.equal(row.place, '45.2700, -66.0600');
    assert.equal(row.text.includes('Planted'), false, row.text);
    assert.ok(
      warned.some((line) => line.includes('Answer too large')),
      warned.join('\n'),
    );
  });
});

test('poller: a new call for help says its street is still being looked up until the address lands', async () => {
  await withPeer(async ({ request, script, poll }) => {
    let answerLookup;
    const held = new Promise((resolve) => {
      answerLookup = resolve;
    });
    script(async (url) => {
      if (url === PEER_NETWORK) return releasedBody();
      if (url.startsWith('https://nominatim')) {
        await held;
        return SAINT_JOHN;
      }
      return null;
    });
    const row = async () => (await request('/status')).json().inbox[0];
    // The row is there at once, with coordinates, marked as still placing,
    // so the box can hold its voice for the street.
    const round = poll(Date.now());
    await flush(12);
    const waiting = await row();
    assert.deepEqual(
      [waiting.active, waiting.placing, waiting.place],
      [true, true, '45.2700, -66.0600'],
    );
    answerLookup();
    await round;
    const placed = await row();
    assert.deepEqual(
      [placed.placing, placed.place],
      [false, PLACE],
      'the street landed, and nothing is pending any more',
    );
    assert.ok(placed.text.includes(PLACE), placed.text);
  });
});

// ---- the group directory --------------------------------------------------

const RAW_URL =
  'https://raw.githubusercontent.com/group/repo/main/ultra-directory.json';
const API_URL =
  'https://api.github.com/repos/group/repo/contents/ultra-directory.json';

test('directory: UPDATE HOME LIST merges, never removes, and flags MOVED', async () => {
  const { post, request, script, calls, file } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    noteUltraEndpoint(['https://me.tail9.ts.net']);
    const mine = (await mint(post, { label: 'Me', network: true })).revealed;
    await withEnv({ ULTRA_DIRECTORY_URL: undefined }, async () => {
      const bare = await post('/network', { update: true });
      assert.equal(bare.status, 400);
      assert.equal(
        bare.json().error,
        'Set the directory first: SAVE DIRECTORY below (or ULTRA_DIRECTORY_URL in .env, then stop and start npm run dev)',
      );
    });
    await withEnv(
      { ULTRA_DIRECTORY_URL: 'http://plain.example/d.json' },
      async () => {
        const plain = await post('/network', { update: true });
        assert.equal(plain.status, 400);
        assert.equal(plain.json().error, 'The directory address must be https');
      },
    );
    await withEnv(
      { ULTRA_DIRECTORY_URL: RAW_URL, ULTRA_DIRECTORY_WRITE_TOKEN: undefined },
      async () => {
        let document = {
          version: 1,
          entries: [
            { name: 'Sam', address: PEER_ADDRESS, token: PEER_TOKEN },
            { name: 'Ann', link: ANN_LINK },
            {
              name: 'Lan',
              link: `https://box.local/ultra/help/${OTHER_TOKEN}`,
            },
            'junk',
            { name: 'Me', address: mine.address, token: mine.token },
            { name: 'Sam again', address: PEER_ADDRESS, token: PEER_TOKEN },
          ],
        };
        let answer = () => json(document);
        script((url) => (url === RAW_URL ? answer() : null));
        const pulled = await post('/network', { update: true });
        assert.equal(pulled.status, 200, pulled.text);
        const first = pulled.json().network;
        assert.deepEqual(first.directory.lastResult, {
          added: 2,
          updated: 0,
          missing: 0,
          own: 1,
          moved: 0,
          skipped: 2,
          total: 6,
        });
        assert.equal(first.directory.lastUpdateAt, Date.now());
        assert.deepEqual(
          first.entries.map((row) => [row.name, row.source, row.host]),
          [
            ['Sam', 'directory', 'peer.tail9.ts.net'],
            ['Ann', 'directory', 'ann.tail9.ts.net'],
          ],
        );
        const read = calls.find((call) => call.url === RAW_URL);
        assert.equal(read.headers['Cache-Control'], 'no-cache');
        assert.ok(!('Authorization' in read.headers), 'no credential');
        assert.ok(
          !pulled.text.includes('uht1.'),
          'the pull never answers a token',
        );
        // A second pull: Sam renamed and moved, Ann gone from the file.
        document = {
          version: 1,
          entries: [
            {
              name: 'Sam moved',
              link: `https://other.tail9.ts.net/ultra/help/${PEER_TOKEN}`,
            },
          ],
        };
        const second = await post('/network', { update: true });
        assert.deepEqual(second.json().network.directory.lastResult, {
          added: 0,
          updated: 1,
          missing: 1,
          own: 0,
          moved: 1,
          skipped: 0,
          total: 1,
        });
        const rows = second.json().network.entries;
        assert.deepEqual(
          rows.map((row) => [row.name, row.moved, row.directoryMissing]),
          [
            ['Sam moved', true, false],
            ['Ann', false, true],
          ],
        );
        assert.equal(
          JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'))
            .entries[0].base,
          'https://peer.tail9.ts.net',
          'a rewritten host is never followed',
        );
        // Every way the read can fail leaves the list exactly as it is.
        const kept = (await request('/status')).json().network.entries.length;
        for (const [body, status, message] of [
          [
            { status: 404, body: 'no' },
            502,
            'The directory did not answer (HTTP 404): check the address, or the file is private (a GitHub write token lets this machine read it)',
          ],
          [
            { status: 200, body: 'x'.repeat(300_000) },
            502,
            'The directory is larger than 256 KB',
          ],
          [{ status: 200, body: 'not json' }, 502, 'The directory is not JSON'],
          [json(42), 502, 'The directory is not JSON'],
          [
            json({ version: 1, entries: [] }),
            409,
            'The directory has no valid entries; your home list was left alone',
          ],
        ]) {
          answer = () => body;
          const warned = [];
          const warn = console.warn;
          console.warn = (...args) => warned.push(args.map(String).join(' '));
          let failed;
          try {
            failed = await post('/network', { update: true });
          } finally {
            console.warn = warn;
          }
          assert.equal(failed.status, status, message);
          assert.equal(failed.json().error, message);
          assert.equal(
            (await request('/status')).json().network.entries.length,
            kept,
          );
          for (const line of warned)
            assert.ok(
              !line.includes('raw.githubusercontent') &&
                !line.includes('uht1.'),
              line,
            );
        }
        answer = () => ({ throws: 'offline' });
        const gone = await post('/network', { update: true });
        assert.equal(gone.status, 502);
        assert.equal(
          gone.json().error,
          'The directory did not answer (is the internet on?)',
        );
        assert.deepEqual(
          (await request('/status')).json().network.directory.lastResult,
          { error: 'The directory did not answer (is the internet on?)' },
        );
      },
    );
    // A private GitHub file: a plain 404 is retried through the API, once.
    await withEnv(
      {
        ULTRA_DIRECTORY_URL: RAW_URL,
        ULTRA_DIRECTORY_WRITE_TOKEN: 'github_pat_fixture',
      },
      async () => {
        const seen = [];
        script((url, call) => {
          seen.push({ url, headers: call.headers });
          if (url === RAW_URL) return { status: 404, body: 'no' };
          if (url.startsWith(API_URL))
            return json({
              version: 1,
              entries: [{ name: 'Ann', link: ANN_LINK }],
            });
          return null;
        });
        const pulled = await post('/network', { update: true });
        assert.equal(pulled.status, 200, pulled.text);
        const api = seen.find((call) => call.url.startsWith(API_URL));
        assert.equal(api.headers.Authorization, 'Bearer github_pat_fixture');
        assert.equal(api.headers.Accept, 'application/vnd.github.raw+json');
        assert.equal(new URL(api.url).host, 'api.github.com');
        assert.equal(
          (await request('/status')).json().network.directory.canPublish,
          true,
        );
      },
    );
  } finally {
    clock.restore();
  }
});

test('directory: a link flagged NOT IN DIRECTORY or MOVED mid-call is followed at its old base until that call ends', async () => {
  for (const mode of ['missing', 'moved']) {
    const { post, request, script, calls, poll, pins } = setup();
    const clock = withClock(Date.UTC(2026, 8, 28, 18));
    try {
      noteUltraEndpoint(['https://me.tail9.ts.net']);
      await withEnv(
        {
          ULTRA_DIRECTORY_URL: RAW_URL,
          ULTRA_DIRECTORY_WRITE_TOKEN: undefined,
        },
        async () => {
          let document = {
            version: 1,
            entries: [
              { name: 'Sam', address: PEER_ADDRESS, token: PEER_TOKEN },
            ],
          };
          let peer = () => releasedBody();
          script((url) => {
            if (url === RAW_URL) return json(document);
            if (url === PEER_NETWORK) return peer();
            if (url.startsWith('https://nominatim')) return SAINT_JOHN;
            if (url.includes('.ts.net')) return json({ released: false });
            return null;
          });
          const pulled = await post('/network', { update: true });
          assert.equal(pulled.status, 200, pulled.text);
          await poll(Date.now());
          assert.equal((await request('/status')).json().inbox[0].active, true);
          // Sam's call is running when the directory stops listing Sam, or
          // lists Sam's token on another machine.
          document =
            mode === 'missing'
              ? { version: 1, entries: [{ name: 'Ann', link: ANN_LINK }] }
              : {
                  version: 1,
                  entries: [
                    {
                      name: 'Sam',
                      link: `https://other.tail9.ts.net/ultra/help/${PEER_TOKEN}`,
                    },
                  ],
                };
          const flagged = await post('/network', { update: true });
          assert.equal(flagged.status, 200, flagged.text);
          assert.equal(
            flagged.json().network.entries[0][
              mode === 'missing' ? 'directoryMissing' : 'moved'
            ],
            true,
          );
          // Sam stands down, and that is still heard where Sam was trusted.
          peer = () => json({ released: false });
          clock.tick(20_001);
          await poll(Date.now());
          const [row] = (await request('/status')).json().inbox;
          assert.equal(row.active, false, mode);
          assert.deepEqual(pins(Date.now()), [], mode);
          // With the call over, the flagged link is not polled any more.
          const asked = () =>
            calls.filter((call) => call.url === PEER_NETWORK).length;
          const before = asked();
          for (let round = 0; round < 3; round += 1) {
            clock.tick(20_001);
            await poll(Date.now());
          }
          assert.equal(asked(), before, mode);
          assert.ok(
            !calls.some((call) => call.url.includes('other.tail9.ts.net')),
            'the host the directory now names is never asked',
          );
        },
      );
    } finally {
      clock.restore();
    }
  }
});

test('directory: what another owner action saves while UPDATE HOME LIST waits on the directory is kept', async () => {
  const BOB_LINK = `https://bob.tail9.ts.net/ultra/help/${OTHER_TOKEN}`;
  const document = {
    version: 1,
    entries: [
      { name: 'Sam', address: PEER_ADDRESS, token: PEER_TOKEN },
      { name: 'Bob', link: BOB_LINK },
    ],
  };
  /** A directory read that answers only when the test says so. */
  const heldRead = (script) => {
    let answer = null;
    script((url) =>
      url === RAW_URL
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : null,
    );
    return async () => {
      for (let turn = 0; !answer && turn < 50; turn += 1) await flush(1);
      assert.ok(answer, 'the directory was asked');
      return answer;
    };
  };
  const names = (entries) => entries.map((entry) => entry.name).sort();
  await withEnv(
    { ULTRA_DIRECTORY_URL: RAW_URL, ULTRA_DIRECTORY_WRITE_TOKEN: undefined },
    async () => {
      // An ADD and SET NAME land, and a RENAME the disk refuses rolls back,
      // all while the read is out: the merge lands beside every one of them.
      {
        const { post, request, script, file, refuseWrites } = setup();
        noteUltraEndpoint(['https://me.tail9.ts.net']);
        const read = heldRead(script);
        const updating = post('/network', { update: true });
        const answer = await read();
        const added = await post('/network', {
          add: true,
          address: ANN_ADDRESS,
          token: ANN_TOKEN,
          name: 'Ann',
        });
        assert.equal(added.status, 200, added.text);
        const annId = added.json().network.entries[0].id;
        assert.equal(
          (await post('/network', { me: true, name: 'Jeff' })).status,
          200,
        );
        refuseWrites(true);
        const refused = await post('/network', {
          rename: true,
          id: annId,
          name: 'Annie',
        });
        assert.equal(refused.status, 409, refused.text);
        refuseWrites(false);
        answer(json(document));
        const updated = await updating;
        assert.equal(updated.status, 200, updated.text);
        const status = (await request('/status')).json().network;
        assert.deepEqual(names(status.entries), ['Ann', 'Bob', 'Sam']);
        assert.equal(status.me.name, 'Jeff');
        const saved = JSON.parse(
          fs.readFileSync(file('ultra-network.json'), 'utf8'),
        );
        assert.deepEqual(names(saved.entries), ['Ann', 'Bob', 'Sam']);
        assert.equal(saved.me.name, 'Jeff');
      }
      // The UPDATE's own write is refused: memory goes back to what is on
      // disk, and that includes the ADD saved while it waited.
      {
        const { post, request, script, file, refuseWrites } = setup();
        noteUltraEndpoint(['https://me.tail9.ts.net']);
        const read = heldRead(script);
        const updating = post('/network', { update: true });
        const answer = await read();
        const added = await post('/network', {
          add: true,
          address: ANN_ADDRESS,
          token: ANN_TOKEN,
          name: 'Ann',
        });
        assert.equal(added.status, 200, added.text);
        refuseWrites(true);
        answer(json(document));
        const updated = await updating;
        assert.equal(updated.status, 409, updated.text);
        refuseWrites(false);
        assert.deepEqual(
          names((await request('/status')).json().network.entries),
          ['Ann'],
        );
        assert.deepEqual(
          names(
            JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'))
              .entries,
          ),
          ['Ann'],
        );
      }
    },
  );
});

test('PUBLISH MY TOKEN: GitHub when it can, an entry to copy when it cannot', async () => {
  const { post, request, script, calls } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    const early = await post('/network', { publish: true });
    assert.equal(early.status, 409);
    assert.equal(
      early.json().error,
      'The report listener is not up, so there is no link to publish yet: keep npm run dev running with the package saved, then try again',
    );
    noteUltraEndpoint(['https://me.tail9.ts.net']);
    await post('/network', { me: true, name: 'Jeff (Van 7)' });
    const clipboard = await post('/network', { publish: true });
    assert.equal(clipboard.status, 200, clipboard.text);
    const published = clipboard.json().published;
    assert.equal(published.how, 'clipboard');
    assert.deepEqual(Object.keys(published.entry), [
      'name',
      'address',
      'token',
    ]);
    assert.equal(published.entry.name, 'Jeff (Van 7)');
    assert.equal(published.entry.address, 'https://me.tail9.ts.net');
    assert.match(published.entry.token, ULTRA_TOKEN_PATTERN);
    assert.ok(
      !published.entryText.includes('/ultra/help/'),
      'the entry is never a joined link',
    );
    assert.equal(published.entryText, JSON.stringify(published.entry, null, 2));
    assert.ok(published.mailto.startsWith('mailto:?subject='));
    assert.equal(published.error, '');
    // The token it made for the group can never text the owner's number, and
    // is location only: its holders get the position poll and nothing else.
    const made = clipboard
      .json()
      .tokens.find((row) => row.label === 'Directory');
    assert.deepEqual(
      [made.sms, made.voice, made.network, made.locationOnly],
      [false, false, true, true],
    );
    // The next poll carries no `published` key at all.
    const status = (await request('/status')).json();
    assert.ok(!('published' in status));
    assert.deepEqual(
      [
        status.network.published.tokenId,
        status.network.published.how,
        status.network.published.live,
      ],
      [made.id, 'clipboard', true],
    );
    // Publishing again reuses the same token; revoking it mints a new one.
    assert.equal(
      (await post('/network', { publish: true })).json().network.published
        .tokenId,
      made.id,
    );
    await post('/tokens', { revoke: true, id: made.id });
    assert.equal(
      (await request('/status')).json().network.published.live,
      false,
    );
    const fresh = (await post('/network', { publish: true })).json();
    assert.notEqual(fresh.network.published.tokenId, made.id);
    // A token the owner chose has to be one that can receive anything.
    const quiet = (await mint(post, { label: 'Courier' })).revealed;
    const refused = await post('/network', { publish: true, id: quiet.id });
    assert.equal(refused.status, 409);
    assert.equal(refused.json().error, 'Choose a live token with NETWORK on');
    // Everyone who reads the directory holds what is in it: a token with SMS
    // on (the owner's number) is refused. New mints store anytime false, so
    // that flag is not a way to publish an always-open page. A stored true
    // flag is still refused by the same sentence.
    const texter = (
      await mint(post, { label: 'Texter', network: true, sms: true })
    ).revealed;
    const risky = await post('/network', { publish: true, id: texter.id });
    assert.equal(risky.status, 409);
    assert.match(risky.json().error, /^That token has SMS or ANYTIME on/);
    const chosen = (
      await mint(post, {
        label: 'Sam',
        network: true,
        sms: false,
        anytime: false,
      })
    ).revealed;
    assert.equal(
      (await post('/network', { publish: true, id: chosen.id })).json().network
        .published.tokenId,
      chosen.id,
    );
    // Published, it is location only for good: SMS ticked on it later changes
    // nothing a directory reader can reach, so DIRECTORY TOKEN still reuses it.
    await post('/tokens', { edit: true, id: chosen.id, sms: true });
    const again = (await post('/network', { publish: true })).json();
    assert.equal(again.network.published.tokenId, chosen.id);
    assert.equal(
      again.tokens.find((row) => row.id === chosen.id).locationOnly,
      true,
    );
    assert.equal(
      (await phone(`/ultra/help/${chosen.token}/status`)).status,
      404,
    );
    await post('/tokens', { edit: true, id: chosen.id, sms: false });
    // A token never published that has SMS on is not reused: the published
    // marker is moved to it only by choosing it, which is refused above.
    // The GitHub path: read, merge, write; nothing of anyone else's is lost.
    await withEnv(
      {
        ULTRA_DIRECTORY_URL: RAW_URL,
        ULTRA_DIRECTORY_WRITE_TOKEN: 'github_pat_fixture',
      },
      async () => {
        const existing = {
          version: 1,
          note: 'kept',
          entries: [{ name: 'Ann', link: ANN_LINK }, { broken: true }],
        };
        let getAnswer = () =>
          json({
            sha: 'abc123',
            content: Buffer.from(JSON.stringify(existing)).toString('base64'),
          });
        let putAnswer = () => json({ content: {} });
        script((url, call) => {
          if (!url.startsWith(API_URL)) return null;
          return call.method === 'PUT' ? putAnswer() : getAnswer();
        });
        const wrote = await post('/network', { publish: true, id: chosen.id });
        assert.equal(wrote.status, 200, wrote.text);
        assert.equal(wrote.json().published.how, 'github');
        assert.equal(wrote.json().published.error, '');
        assert.equal(
          wrote.json().published.directory,
          'https://raw.githubusercontent.com/group/repo/main/ultra-directory.json',
        );
        const put = calls.filter((call) => call.method === 'PUT').at(-1);
        assert.equal(put.url, API_URL);
        assert.equal(put.headers.Authorization, 'Bearer github_pat_fixture');
        assert.equal(put.headers.Accept, 'application/vnd.github+json');
        assert.equal(put.headers['X-GitHub-Api-Version'], '2022-11-28');
        const sent = JSON.parse(put.body);
        assert.deepEqual([sent.sha, sent.branch], ['abc123', 'main']);
        assert.match(
          sent.message,
          /^GEVC Ultra network: .* published a help token$/,
        );
        const written = JSON.parse(
          Buffer.from(sent.content, 'base64').toString('utf8'),
        );
        assert.equal(written.note, 'kept');
        // A legacy element somebody else keeps is left exactly as it is.
        assert.deepEqual(written.entries[0], { name: 'Ann', link: ANN_LINK });
        assert.deepEqual(written.entries[1], { broken: true });
        assert.deepEqual(Object.keys(written.entries[2]), [
          'name',
          'address',
          'token',
        ]);
        assert.equal(written.entries[2].address, 'https://me.tail9.ts.net');
        for (const call of calls)
          if (call.headers && call.headers.Authorization)
            assert.equal(
              new URL(call.url).host,
              'api.github.com',
              'the write token goes nowhere else',
            );
        // A file that is not there yet is created with no sha.
        getAnswer = () => ({ status: 404, body: 'no' });
        await post('/network', { publish: true, id: chosen.id });
        const created = JSON.parse(
          calls.filter((call) => call.method === 'PUT').at(-1).body,
        );
        assert.ok(!('sha' in created));
        // Somebody else's write landing first is retried exactly once.
        getAnswer = () =>
          json({
            sha: 'abc123',
            content: Buffer.from('{"entries":[]}').toString('base64'),
          });
        let puts = 0;
        putAnswer = () => {
          puts += 1;
          return puts === 1 ? { status: 409, body: 'conflict' } : json({});
        };
        const retried = await post('/network', {
          publish: true,
          id: chosen.id,
        });
        assert.equal(retried.json().published.how, 'github');
        assert.equal(puts, 2);
        // A refused token, and a file nobody should clobber.
        puts = 0;
        putAnswer = () => ({ status: 401, body: 'nope' });
        const denied = await post('/network', { publish: true, id: chosen.id });
        assert.equal(denied.status, 200);
        assert.equal(denied.json().published.how, 'clipboard');
        assert.equal(
          denied.json().published.error,
          'GitHub refused the write token (401): it needs Contents read and write on that repository',
        );
        assert.ok(denied.json().published.entryText.includes('"address"'));
        assert.ok(denied.json().published.entryText.includes('"token"'));
        getAnswer = () =>
          json({
            sha: 'abc123',
            content: Buffer.from('{not json').toString('base64'),
          });
        const before = calls.filter((call) => call.method === 'PUT').length;
        const junk = await post('/network', { publish: true, id: chosen.id });
        assert.equal(junk.json().published.how, 'clipboard');
        assert.equal(
          junk.json().published.error,
          'The directory file is not JSON; ask the maintainer to fix it, or send them this entry',
        );
        assert.equal(
          calls.filter((call) => call.method === 'PUT').length,
          before,
          'a hand-kept file is never written over',
        );
      },
    );
  } finally {
    clock.restore();
  }
});

test('PUBLISH clicked twice while GitHub answers makes one token and one directory entry', async () => {
  const { post, script, file } = setup();
  noteUltraEndpoint(['https://me.tail9.ts.net']);
  await post('/network', { me: true, name: 'Jeff' });
  await withEnv(
    {
      ULTRA_DIRECTORY_URL: RAW_URL,
      ULTRA_DIRECTORY_WRITE_TOKEN: 'github_pat_fixture',
    },
    async () => {
      // A slow GitHub that keeps the file and its sha, and refuses a write
      // made against a sha that is no longer current, as the real one does.
      let doc = { version: 1, entries: [] };
      let version = 0;
      script(async (url, call) => {
        if (!url.startsWith(API_URL)) return null;
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (call.method !== 'PUT')
          return json({
            sha: `sha-${version}`,
            content: Buffer.from(JSON.stringify(doc)).toString('base64'),
          });
        const sent = JSON.parse(call.body);
        if (sent.sha !== `sha-${version}`)
          return { status: 409, body: 'conflict' };
        doc = JSON.parse(Buffer.from(sent.content, 'base64').toString('utf8'));
        version += 1;
        return json({ content: {} });
      });
      const answers = await Promise.all([
        post('/network', { publish: true }),
        post('/network', { publish: true }),
      ]);
      assert.deepEqual(
        answers.map((answer) => [answer.status, answer.json().published?.how]),
        [
          [200, 'github'],
          [200, 'github'],
        ],
      );
      const directory = JSON.parse(
        fs.readFileSync(file('ultra-tokens.json'), 'utf8'),
      ).tokens.filter(
        (item) => item.label === 'Directory' && item.revokedAt === null,
      );
      assert.equal(directory.length, 1, 'one Directory token');
      assert.deepEqual(
        doc.entries.map((item) => item.name),
        ['Jeff'],
      );
      assert.equal(
        answers[1].json().network.published.tokenId,
        directory[0].id,
      );
    },
  );
});

// ---- the SMS relay --------------------------------------------------------

const TWILIO = {
  TWILIO_ACCOUNT_SID: `AC${'f'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'auth-fixture',
  TWILIO_FROM_NUMBER: '+15065550000',
  ULTRA_SMS_RELAY_URL: undefined,
  ULTRA_SMS_RELAY_TOKEN: undefined,
};
const TWILIO_URL = `https://api.twilio.com/2010-04-01/Accounts/AC${'f'.repeat(32)}/Messages.json`;

test('SMS relay: one text per call for help, budgeted, and no secret in any answer', async () => {
  await withEnv(TWILIO, async () => {
    await withPeer(
      async ({ request, post, script, calls, poll, clock, entry }) => {
        let relay = () => ({
          status: 201,
          body: JSON.stringify({ sid: 'SM1' }),
        });
        let peer = () => releasedBody();
        script((url) => {
          if (url === PEER_NETWORK) return peer();
          if (url.startsWith('https://nominatim')) return SAINT_JOHN;
          if (url === TWILIO_URL) return relay();
          return null;
        });
        // With no number of the owner's own there is nowhere to send.
        await poll(Date.now());
        await flush();
        assert.equal(
          calls.filter((call) => call.url === TWILIO_URL).length,
          0,
          'nothing is sent without SAVE MY #',
        );
        // The relay is set up; what is missing is SAVE MY #, and the row
        // says that rather than that there is no relay.
        assert.equal(
          (await request('/status')).json().inbox[0].sms,
          'NO SMS: SAVE MY # FIRST',
        );
        await post('/number', { number: '+15065550199' });
        // A second episode, past the gap, is the one that texts.
        clock.tick(600_001);
        peer = () => json({ released: false });
        await poll(Date.now());
        clock.tick(600_001);
        peer = () => releasedBody();
        await poll(Date.now());
        await flush();
        const sent = calls.filter((call) => call.url === TWILIO_URL);
        assert.equal(sent.length, 1);
        assert.equal(
          sent[0].headers.Authorization,
          `Basic ${Buffer.from(`AC${'f'.repeat(32)}:auth-fixture`).toString('base64')}`,
        );
        assert.equal(
          sent[0].headers['Content-Type'],
          'application/x-www-form-urlencoded',
        );
        assert.equal(sent[0].redirect, 'error');
        const form = new URLSearchParams(sent[0].body);
        assert.equal(form.get('To'), '+15065550199');
        assert.equal(form.get('From'), '+15065550000');
        assert.equal(
          form.get('Body'),
          `VAN 7 NEEDS HELP: Please HELP you are close by, to ${PLACE} of victim in progress, fire thank you.`,
        );
        const rows = (await request('/status')).json();
        assert.match(rows.inbox[0].sms, /^SMS SENT \d\d:\d\d$/);
        assert.equal(rows.network.relay.provider, 'twilio');
        assert.equal(rows.network.relay.host, 'api.twilio.com');
        assert.equal(rows.network.relay.sentToday, 1);
        // A second call from the same peer inside ten minutes texts nobody.
        clock.tick(20_001);
        peer = () => json({ released: false });
        await poll(Date.now());
        clock.tick(20_001);
        peer = () => releasedBody();
        await poll(Date.now());
        await flush();
        assert.equal(calls.filter((call) => call.url === TWILIO_URL).length, 1);
        // The provider's own refusal becomes a code, never a sentence.
        clock.tick(600_001);
        peer = () => json({ released: false });
        await poll(Date.now());
        clock.tick(600_001);
        relay = () => ({
          status: 400,
          body: JSON.stringify({
            code: 21211,
            message: 'To is not valid: +1506…',
          }),
        });
        peer = () => releasedBody();
        await poll(Date.now());
        await flush();
        const failed = (await request('/status')).json();
        assert.equal(failed.inbox[0].sms, 'SMS FAILED: 21211');
        assert.ok(
          !JSON.stringify(failed).includes('To is not valid'),
          "a provider's own words never come back",
        );
        // TEST SMS: one every ten minutes, and never a secret in the answer.
        const test1 = await post('/network', { testSms: true });
        assert.equal(test1.status, 200, test1.text);
        await flush();
        const again = await post('/network', { testSms: true });
        assert.equal(again.status, 429);
        assert.equal(again.json().error, 'One test every 10 minutes');
        const whole = JSON.stringify((await request('/status')).json());
        for (const secret of [
          'auth-fixture',
          `AC${'f'.repeat(32)}`,
          '+15065550000',
        ])
          assert.ok(!whole.includes(secret), secret);
        assert.equal(
          (await request('/status')).json().network.relay.lastTestAt,
          Date.now(),
        );
        // Fifty a day, and the fifty-first waits for tomorrow.
        for (let i = 0; i < 60; i += 1) {
          clock.tick(600_001);
          const answer = await post('/network', { testSms: true });
          if (answer.status === 429) {
            assert.equal(
              answer.json().error,
              'The SMS relay has sent all it may for now',
            );
            assert.ok(i > 0 && i < 60, `refused at ${i}`);
            return;
          }
        }
        assert.fail('the daily cap never bit');
      },
    );
  });
});

test('SMS relay: the victim side texts the saved helpers, never 911, and never blocks a poll', async () => {
  await withEnv(TWILIO, async () => {
    const { post, request, script, calls, poll } = setup();
    const clock = withClock(Date.UTC(2026, 8, 28, 18));
    try {
      let relay = () => ({ status: 201, body: JSON.stringify({ sid: 'SM1' }) });
      script((url) => {
        if (url.startsWith('https://nominatim')) return SAINT_JOHN;
        if (url === TWILIO_URL) return relay();
        return null;
      });
      for (const [label, number] of [
        ['Neighbour', '+15065550100'],
        ['Cousin', '+15065550101'],
      ])
        await post('/contacts', { label, number, kind: 'other' });
      // 911 is not a number anybody saves here, which is exactly why a relay
      // can never text it: it reaches the phone from Send Ultra Help alone.
      assert.equal(
        (
          await post('/contacts', {
            label: 'Police',
            number: '911',
            kind: 'police',
          })
        ).status,
        400,
      );
      noteUltraPosition({
        key: VAN_KEY,
        name: 'Van 7',
        lat: 45.27,
        lon: -66.06,
        at: Date.now(),
      });
      await post('/release', { incident: 'fire' });
      await poll(Date.now());
      await flush();
      const sent = calls.filter((call) => call.url === TWILIO_URL);
      assert.equal(sent.length, 2, 'one text per saved helper');
      assert.deepEqual(
        sent.map((call) => new URLSearchParams(call.body).get('To')).sort(),
        ['+15065550100', '+15065550101'],
      );
      const status = (await request('/status')).json();
      assert.deepEqual(
        [status.release.sms.sent, status.release.sms.failed],
        [2, 0],
      );
      assert.match(status.release.sms.outcome, /^SMS SENT \d\d:\d\d$/);
      // The phone still gets the one card, with both numbers on it.
      const popped = (await phone(`/ultra/${VAN_KEY}`)).json();
      assert.equal(popped.notify[0].kind, 'sms');
      assert.deepEqual(popped.notify[0].numbers, [
        '+15065550100',
        '+15065550101',
      ]);
      // A relay that never answers holds nothing else up.
      relay = () => ({ hang: true });
      clock.tick(600_001);
      await post('/release', { standDown: true });
      await post('/release', { incident: 'medical' });
      await poll(Date.now());
      const began = process.hrtime.bigint();
      assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 200);
      assert.equal((await request('/status')).status, 200);
      const spent = Number(process.hrtime.bigint() - began) / 1e6;
      assert.ok(spent < 1000, `the poll answered in ${spent} ms`);
    } finally {
      clock.restore();
    }
  });
});

test('SMS relay: a failed text is retried by EXTEND HELP a minute later and never reported as already texted', async () => {
  await withEnv(TWILIO, async () => {
    const { post, request, script, calls, poll } = setup();
    const clock = withClock(Date.UTC(2026, 8, 28, 18));
    const texts = () => calls.filter((call) => call.url === TWILIO_URL).length;
    const line = async () => (await request('/status')).json().release.sms;
    const settle = async () => {
      await poll(Date.now());
      await flush();
    };
    try {
      let relay = () => ({
        status: 400,
        body: JSON.stringify({ code: 21211 }),
      });
      script((url) => {
        if (url.startsWith('https://nominatim')) return SAINT_JOHN;
        if (url === TWILIO_URL) return relay();
        return null;
      });
      await post('/contacts', {
        label: 'Neighbour',
        number: '+15065550100',
        kind: 'other',
      });
      noteUltraPosition({
        key: VAN_KEY,
        name: 'Van 7',
        lat: 45.27,
        lon: -66.06,
        at: Date.now(),
      });
      await post('/release', { incident: 'threat' });
      await settle();
      assert.deepEqual(Object.values(await line()), [
        'SMS FAILED: 21211',
        0,
        1,
      ]);
      // A minute later EXTEND HELP tries that number again: the failed send
      // shortened its cooldown to a minute and gave back its place in the day.
      relay = () => ({ status: 201, body: JSON.stringify({ sid: 'SM1' }) });
      clock.tick(60_000);
      await post('/release', { incident: 'threat' });
      await settle();
      assert.equal(texts(), 2);
      const sent = await line();
      assert.match(sent.outcome, /^SMS SENT \d\d:\d\d$/);
      assert.deepEqual([sent.sent, sent.failed], [1, 0]);
      // EXTEND again inside ten minutes: that text stands and is not sent
      // twice, and the line still says it was sent — not SENDING, not
      // ALREADY TEXTED.
      clock.tick(60_000);
      await post('/release', { incident: 'threat' });
      await settle();
      assert.equal(texts(), 2);
      assert.equal((await line()).outcome, sent.outcome);
      // A new call (after STAND DOWN) starts its own record.
      await post('/release', { standDown: true });
      relay = () => ({ hang: true });
      await post('/release', { incident: 'fire' });
      await settle();
      assert.equal((await line()).outcome, 'SENDING');
    } finally {
      clock.restore();
    }
  });
});

test('SMS relay: a generic gateway posts JSON under a bearer token', async () => {
  await withEnv(
    {
      ...TWILIO,
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_FROM_NUMBER: undefined,
      ULTRA_SMS_RELAY_URL: 'https://sms.example/send',
      ULTRA_SMS_RELAY_TOKEN: 'gateway-fixture',
    },
    async () => {
      const { post, request, script, calls } = setup();
      script((url) =>
        url === 'https://sms.example/send' ? json({ ok: true }) : null,
      );
      await post('/number', { number: '+15065550199' });
      const relay = (await request('/status')).json().network.relay;
      assert.deepEqual(
        [relay.provider, relay.configured, relay.host],
        ['generic', true, 'sms.example'],
      );
      const tested = await post('/network', { testSms: true });
      assert.equal(tested.status, 200, tested.text);
      await flush();
      const call = calls.find(
        (item) => item.url === 'https://sms.example/send',
      );
      assert.equal(call.method, 'POST');
      assert.equal(call.headers.Authorization, 'Bearer gateway-fixture');
      assert.deepEqual(JSON.parse(call.body), {
        to: '+15065550199',
        body: 'GEVC Ultra test: this phone receives help network alerts.',
      });
      assert.ok(
        !JSON.stringify((await request('/status')).json()).includes(
          'gateway-fixture',
        ),
      );
    },
  );
});

test('a relay that is not configured refuses TEST SMS with the way to set one up', async () => {
  await withEnv(
    {
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_FROM_NUMBER: undefined,
      ULTRA_SMS_RELAY_URL: undefined,
      ULTRA_SMS_RELAY_TOKEN: undefined,
    },
    async () => {
      const { post, request } = setup();
      const none = await post('/network', { testSms: true });
      assert.equal(none.status, 409);
      assert.equal(
        none.json().error,
        'No SMS relay is configured: add Twilio or your own gateway under POWER UP',
      );
      assert.deepEqual((await request('/status')).json().network.relay, {
        provider: '',
        configured: false,
        host: '',
        lastTestAt: null,
        lastOutcome: '',
        sentToday: 0,
      });
    },
  );
});

test('a configured relay with no number of the owner’s own says where to put one', async () => {
  await withEnv(TWILIO, async () => {
    const { post } = setup();
    const none = await post('/network', { testSms: true });
    assert.equal(none.status, 409);
    assert.equal(
      none.json().error,
      'SAVE MY # first: the test goes to your own cell',
    );
  });
});

// ---- admission ------------------------------------------------------------

test('admission: /release and /network answer only this machine and only this page', async () => {
  const { request } = setup();
  for (const pathName of ['/release', '/network']) {
    const refused = async (options, status, pattern) => {
      const answer = await request(pathName, {
        method: 'POST',
        headers: PAGE,
        body: { standDown: true },
        ...options,
      });
      assert.equal(answer.status, status, `${pathName} ${answer.text}`);
      if (pattern) assert.match(answer.json().error, pattern);
    };
    await refused({ remoteAddress: '192.168.1.2' }, 403);
    await refused(
      { headers: { ...PAGE, 'x-forwarded-for': '203.0.113.9' } },
      403,
      /proxied/,
    );
    await refused({ headers: { ...PAGE, origin: 'http://evil.test' } }, 403);
    await refused(
      { headers: { ...PAGE, 'sec-fetch-site': 'cross-site' } },
      403,
      /only its own page/,
    );
    await refused({ headers: { ...PAGE, 'content-type': 'text/plain' } }, 415);
    await refused(
      { body: `{"name":"${'x'.repeat(20_000)}"}` },
      413,
      /^Request too large$/,
    );
    await refused({ body: '{' }, 400, /^Bad JSON$/);
  }
});

test('removing the row, or clearing the inbox, ends the call for help here', async () => {
  await withPeer(async ({ request, post, script, poll, pins, clock }) => {
    let peer = () => releasedBody();
    script((url) =>
      url === PEER_NETWORK
        ? peer()
        : url.startsWith('https://nominatim')
          ? SAINT_JOHN
          : null,
    );
    await poll(Date.now());
    const [row] = (await request('/status')).json().inbox;
    assert.equal(pins(Date.now()).length, 1);
    const removed = await post('/inbox', { remove: true, id: row.id });
    assert.deepEqual(removed.json().inbox, []);
    assert.deepEqual(pins(Date.now()), [], 'the pin goes with the row');
    // Inside the ten-minute gap there is nothing to reuse and it is too soon
    // for a new row: the same answer opens nothing.
    clock.tick(20_001);
    await poll(Date.now());
    assert.deepEqual((await request('/status')).json().inbox, []);
    assert.deepEqual(pins(Date.now()), []);
    // Past the gap it is a fresh call for help, and CLEAR ends that one.
    clock.tick(600_001);
    await poll(Date.now());
    assert.equal((await request('/status')).json().inbox.length, 1);
    assert.equal(pins(Date.now()).length, 1);
    const cleared = await post('/inbox', { clear: true });
    assert.deepEqual([cleared.json().inbox, cleared.json().unread], [[], 0]);
    assert.deepEqual(pins(Date.now()), []);
  });
});

test('the poller runs under the dev server alone and stops with it', async () => {
  const { plugin, request } = setup();
  const closers = [];
  const httpServer = {
    once: (event, handler) => closers.push([event, handler]),
  };
  const uses = [];
  plugin.configureServer({
    middlewares: { use: (...args) => uses.push(args) },
    httpServer,
  });
  assert.equal((await request('/status')).json().network.polling, true);
  assert.deepEqual(
    closers.map(([event]) => event),
    ['close'],
  );
  // An in-process restart: Vite builds the new server BEFORE closing the old
  // one, so the old server's close arrives last. It must not switch off the
  // poller the new server just started — nobody would hear a call for help
  // again until the process itself was restarted.
  plugin.configureServer({
    middlewares: { use: (...args) => uses.push(args) },
    httpServer,
  });
  closers[0][1]();
  assert.equal(
    (await request('/status')).json().network.polling,
    true,
    'the departing server must not stop the new poller',
  );
  // The server that owns the timer does stop it.
  closers.at(-1)[1]();
  assert.equal((await request('/status')).json().network.polling, false);
});

// ---- directory tokens, links, cards and restarts --------------------------

test('every token answers the position poll alone, the directory token too, during a call as well', async () => {
  const { post, request } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    noteUltraEndpoint(['https://me.tail9.ts.net']);
    await post('/number', { number: '+15065550199' });
    const published = await post('/network', { publish: true });
    assert.equal(published.status, 200, published.text);
    const directory = published.json().published.entry.token;
    // A friend the owner handed a token by hand, SMS ticked as it once was.
    const friend = (
      await mint(post, {
        label: 'Friend',
        sms: true,
        network: true,
      })
    ).revealed.token;
    // No call: neither token has a page or a status, and the poll says
    // "not now".
    for (const token of [friend, directory]) {
      for (const tail of ['', '/status'])
        assert.equal((await phone(`/ultra/help/${token}${tail}`)).status, 404);
      assert.deepEqual((await net(token)).json(), {
        released: false,
      });
    }
    // SEND HELP: both tokens still answer the position poll alone.
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    assert.equal((await post('/release', { incident: 'threat' })).status, 200);
    assert.equal((await net(directory)).json().released, true);
    assert.equal((await net(friend)).json().released, true);
    for (const token of [friend, directory]) {
      for (const tail of ['', '/status'])
        assert.equal(
          (await phone(`/ultra/help/${token}${tail}`)).status,
          404,
          `${tail || 'page'} during the call`,
        );
      const message = await phone(`/ultra/help/${token}/message`, {
        method: 'POST',
        headers: JSON_BODY,
        body: { text: 'where are you? call me' },
      });
      assert.deepEqual([message.status, message.text], [404, 'Not found']);
    }
    assert.deepEqual(
      (await phone(`/ultra/${VAN_KEY}`))
        .json()
        .notify.filter((card) => card.kind !== 'sms'),
      [],
      'nothing reached the phone',
    );
    // After STAND DOWN the poll says "not now" again.
    await post('/release', { standDown: true });
    assert.deepEqual((await net(friend)).json(), {
      released: false,
    });
    // A token published by id becomes location only for good: ANYTIME
    // ticked on it afterwards cannot reopen its page.
    const chosen = (
      await mint(post, {
        label: 'Sam',
        network: true,
        sms: false,
        anytime: false,
      })
    ).revealed;
    await post('/network', { publish: true, id: chosen.id });
    const row = (await request('/status'))
      .json()
      .tokens.find((item) => item.id === chosen.id);
    assert.equal(row.locationOnly, true);
    await post('/tokens', { edit: true, id: chosen.id, anytime: true });
    assert.equal(
      (await request('/status'))
        .json()
        .tokens.find((item) => item.id === chosen.id).anytime,
      false,
    );
    assert.equal((await phone(`/ultra/help/${chosen.token}`)).status, 404);
    assert.deepEqual((await net(chosen.token)).json(), { released: false });
  } finally {
    clock.restore();
  }
});

test('PUBLISH and NETWORK links carry the tailnet address, never a LAN one', async () => {
  const { post, request } = setup();
  noteUltraEndpoint(['http://192.168.1.5:44173']);
  const refused = await post('/network', { publish: true });
  assert.equal(refused.status, 409);
  assert.match(
    refused.json().error,
    /^This machine has no tailnet address to publish/,
  );
  assert.equal((await request('/status')).json().networkBase, '');
  noteUltraEndpoint([
    'http://192.168.1.5:44173',
    'http://100.101.102.103:44173',
    'https://me.tail9.ts.net',
  ]);
  const published = await post('/network', { publish: true });
  assert.equal(published.status, 200, published.text);
  assert.equal(
    published.json().published.entry.address,
    'https://me.tail9.ts.net',
  );
  // NEW TOKEN: a NETWORK token is handed out beside the tailnet address, a
  // bare origin; a message-only token opens nothing and gets no address.
  const networked = (await mint(post, { label: 'Sam', network: true }))
    .revealed;
  assert.equal(networked.address, 'https://me.tail9.ts.net');
  assert.ok(!('link' in networked));
  const plain = (await mint(post, { label: 'Courier' })).revealed;
  assert.ok(!('address' in plain) && !('link' in plain));
  assert.equal(
    (await request('/status')).json().networkBase,
    'https://me.tail9.ts.net',
  );
  // A 100.64.0.0/10 literal serves when there is no .ts.net name.
  noteUltraEndpoint([
    'http://192.168.1.5:44173',
    'http://100.101.102.103:44173',
  ]);
  assert.equal(
    (await request('/status')).json().networkBase,
    'http://100.101.102.103:44173',
  );
  assert.equal(
    (await mint(post, { label: 'Kim', network: true })).revealed.address,
    'http://100.101.102.103:44173',
  );
});

test('removing a long-ended NEEDS HELP row never hides the next call from that person', async () => {
  await withPeer(async ({ post, request, script, poll, clock }) => {
    let peer = () => releasedBody();
    script((url) => (url === PEER_NETWORK ? peer() : null));
    await poll(Date.now());
    const first = (await request('/status')).json().inbox[0];
    assert.equal(first.active, true);
    // They stand down; half an hour later the owner tidies the row away.
    peer = () => json({ released: false });
    clock.tick(20_001);
    await poll(Date.now());
    clock.tick(30 * 60_000);
    await post('/inbox', { remove: true, id: first.id });
    // A minute after that, a brand-new SEND HELP: it raises a row at once.
    clock.tick(60_000);
    peer = () => releasedBody();
    await poll(Date.now());
    const rows = (await request('/status')).json().inbox;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'release');
    assert.equal(rows[0].active, true);
    assert.notEqual(rows[0].id, first.id);
  });
});

test('STAND DOWN takes back the plea card the phone has not popped, and EXTEND never stacks a second', async () => {
  const { post, poll } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    await post('/contacts', {
      label: 'Neighbour',
      number: '+15065550100',
      kind: 'other',
    });
    const fix = () =>
      noteUltraPosition({
        key: VAN_KEY,
        name: 'Van 7',
        lat: 45.27,
        lon: -66.06,
        at: Date.now(),
      });
    fix();
    await post('/release', { incident: 'fire' });
    await poll(Date.now());
    await post('/release', { standDown: true });
    assert.deepEqual((await phone(`/ultra/${VAN_KEY}`)).json().notify, []);
    // A card for a call whose window has run out is not handed over either.
    await post('/release', { incident: 'fire' });
    await poll(Date.now());
    clock.tick(14_400_001);
    assert.deepEqual((await phone(`/ultra/${VAN_KEY}`)).json().notify, []);
    // EXTEND before the phone polls: one card, the newest, and nothing of
    // this machine's bookkeeping on it.
    fix();
    await post('/release', { incident: 'fire' });
    await poll(Date.now());
    clock.tick(60_000);
    await post('/release', { incident: 'fire' });
    await poll(Date.now());
    const cards = (await phone(`/ultra/${VAN_KEY}`)).json().notify;
    assert.equal(cards.length, 1);
    assert.deepEqual(Object.keys(cards[0]).sort(), [
      'at',
      'id',
      'kind',
      'numbers',
      'text',
    ]);
  } finally {
    clock.restore();
  }
});

test('another package calling does not open this token', async () => {
  const { post } = setup({ feeds: [VAN, HOME] });
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    const sitter = (
      await mint(post, {
        label: 'Sitter',
        network: true,
        feedId: 'security-home',
      })
    ).revealed.token;
    const poll = async () => (await net(sitter)).json();
    assert.deepEqual(await poll(), { released: false });
    // The call is on the van. The Home token's poll says "not now".
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    await post('/release', { incident: 'threat', feedId: 'security-van' });
    assert.deepEqual(await poll(), { released: false });
    // Home asking is what opens it, and Home's call is what it carries.
    noteUltraPosition({
      key: HOME_KEY,
      name: 'Home',
      lat: 45.3,
      lon: -66.1,
      at: Date.now(),
    });
    assert.equal(
      (await post('/release', { incident: 'fire', feedId: 'security-home' }))
        .status,
      200,
    );
    const asking = await poll();
    assert.deepEqual(
      [asking.released, asking.name, asking.lat, asking.incident],
      [true, 'Home', 45.3, 'fire'],
    );
    await post('/release', { standDown: true, feedId: 'security-van' });
    assert.equal((await poll()).released, true);
    await post('/release', { standDown: true, feedId: 'security-home' });
    assert.deepEqual(await poll(), { released: false });
  } finally {
    clock.restore();
  }
});

test('while the owner is asking for help, a call from the home list is shown but never texted to their cell', async () => {
  await withEnv(TWILIO, async () => {
    await withPeer(async ({ post, request, script, calls, poll }) => {
      await post('/number', { number: '+15065550199' });
      script((url) => {
        if (url === PEER_NETWORK)
          return releasedBody({ name: 'SHE IS IN THE BASEMENT ANSWER' });
        if (url === TWILIO_URL)
          return { status: 201, body: JSON.stringify({ sid: 'SM1' }) };
        return null;
      });
      // The owner's own THREAT call is on.
      noteUltraPosition({
        key: VAN_KEY,
        name: 'Van 7',
        lat: 45.2,
        lon: -66,
        at: Date.now(),
      });
      assert.equal(
        (await post('/release', { incident: 'threat' })).status,
        200,
      );
      await poll(Date.now());
      await flush();
      // No text to the owner's own cell; the row says it was held.
      const texts = calls.filter(
        (call) =>
          call.url === TWILIO_URL &&
          new URLSearchParams(call.body).get('To') === '+15065550199',
      );
      assert.equal(texts.length, 0);
      const row = (await request('/status'))
        .json()
        .inbox.find((item) => item.kind === 'release');
      assert.equal(row.sms, 'SMS HELD: YOUR CALL IS ON');
    });
  });
});

test('a refused save neither refuses nor loses SEND HELP or STAND DOWN', async () => {
  const { post, request, file, refuseWrites, restart, poll } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const saved = () =>
    JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8')).releases;
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  try {
    const sam = (
      await mint(post, { label: 'Sam', network: true, anytime: false })
    ).revealed.token;
    await post('/contacts', {
      label: 'Neighbour',
      number: '+15065550100',
      kind: 'other',
    });
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    // The disk refuses the write: the call still goes out, to the holders
    // and as the plea card for the saved helpers.
    refuseWrites(true);
    const sent = await post('/release', { incident: 'threat' });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.json().release.incident, 'threat');
    assert.equal((await net(sam)).json().released, true);
    await poll(Date.now());
    assert.equal(
      (await phone(`/ultra/${VAN_KEY}`)).json().notify[0].kind,
      'sms',
    );
    assert.deepEqual(saved(), []);
    // Said once in the terminal, with the code and nothing else.
    assert.deepEqual(
      warned.filter((line) => line.includes('not saved to disk')),
      [
        '[Ultra help] SEND HELP state not saved to disk (GEV_HARDEN_FAILED); retrying',
      ],
    );
    // Writes work again: the box's next status poll saves the call.
    refuseWrites(false);
    clock.tick(15_001);
    await request('/status');
    assert.equal(saved().length, 1);
    // STAND DOWN, from the box and from the phone, with the disk refusing.
    refuseWrites(true);
    const down = await post('/release', { standDown: true });
    assert.equal(down.status, 200, down.text);
    assert.deepEqual(down.json().releases, []);
    const phoneDown = await phone(`/ultra/${VAN_KEY}/help`, {
      method: 'POST',
      headers: JSON_BODY,
      body: { standDown: true },
    });
    assert.equal(phoneDown.status, 200, phoneDown.text);
    assert.deepEqual(
      (await net(sam)).json(),
      { released: false },
      'the call has ended for the holders at once',
    );
    // The retry waits fifteen seconds after the last attempt, then lands.
    refuseWrites(false);
    await request('/status');
    assert.equal(saved().length, 1, 'not retried on every poll');
    clock.tick(15_001);
    await request('/status');
    assert.deepEqual(saved(), []);
    // A restart cannot bring the call back.
    const back = restart();
    assert.equal((await back.request('/status')).json().release, null);
    assert.deepEqual((await net(sam)).json(), {
      released: false,
    });
  } finally {
    console.warn = warn;
    clock.restore();
  }
});

test('a STAND DOWN the disk refused stays down when a dev-server restart loads this module afresh', async () => {
  const { root, post, file, harden, refuseWrites } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const saved = () =>
    JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8')).releases;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const sam = (
      await mint(post, { label: 'Sam', network: true, anytime: false })
    ).revealed.token;
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    assert.equal((await post('/release', { incident: 'threat' })).status, 200);
    assert.equal(saved().length, 1);
    refuseWrites(true);
    const down = await post('/release', { standDown: true });
    assert.equal(down.status, 200, down.text);
    assert.equal(saved().length, 1, 'the file is behind');
    // A POWER UP save before the retry lands: Vite evaluates this module
    // again, and the fresh copy reads the file that still holds the call.
    const fresh = await import(
      new URL(
        '../server/providers/ultra-help.js?restart=standdown',
        import.meta.url,
      ).href
    );
    const again = harness(
      fresh.ultraHelpProxy({
        sourceRoot: root,
        harden,
        fetchImpl: async () => {
          throw new Error('offline');
        },
      }),
    );
    const holder = (token) =>
      new Promise((resolve, reject) => {
        Promise.resolve(
          fresh.handleUltraPhone(
            fakeRequest(NETWORK_ROUTE, {
              remoteAddress: HOLDER,
              headers: bearer(token),
            }),
            fakeResponse(resolve),
            new URL(NETWORK_ROUTE, 'http://localhost'),
          ),
        ).catch(reject);
      });
    assert.equal((await again('/status')).json().release, null);
    assert.deepEqual((await holder(sam)).json(), {
      released: false,
    });
    // The disk takes writes again: what the retry writes is the STAND DOWN.
    refuseWrites(false);
    clock.tick(15_001);
    await again('/status');
    assert.deepEqual(saved(), []);
    assert.deepEqual((await holder(sam)).json(), {
      released: false,
    });
  } finally {
    console.warn = warn;
    clock.restore();
  }
});

test('a STAND DOWN the disk refused on the phone is written with no GEV tab open', async () => {
  const { post, file, refuseWrites, restart, poll } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const saved = () =>
    JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8')).releases;
  const warn = console.warn;
  console.warn = () => {};
  const press = (body) =>
    phone(`/ultra/${VAN_KEY}/help`, {
      method: 'POST',
      headers: JSON_BODY,
      body,
    });
  try {
    const sam = (
      await mint(post, { label: 'Sam', network: true, anytime: false })
    ).revealed.token;
    // Out with the phone: the box is never polled from here on.
    for (const retry of ['the phone’s own poll', 'the poller’s tick']) {
      const sent = await press({
        incident: 'threat',
        lat: 45.27,
        lon: -66.06,
        age: 0,
      });
      assert.equal(sent.status, 200, sent.text);
      assert.equal(saved().length, 1);
      refuseWrites(true);
      const down = await press({ standDown: true });
      assert.equal(down.status, 200, down.text);
      assert.equal(saved().length, 1);
      refuseWrites(false);
      clock.tick(15_001);
      if (retry === 'the phone’s own poll') await phone(`/ultra/${VAN_KEY}`);
      else await poll(Date.now());
      assert.deepEqual(saved(), [], retry);
      clock.tick(60_001);
    }
    // So a full restart inside the four hours brings nothing back.
    const back = restart();
    assert.equal((await back.request('/status')).json().release, null);
    assert.deepEqual((await net(sam)).json(), {
      released: false,
    });
  } finally {
    console.warn = warn;
    clock.restore();
  }
});

test('a helpers file unreadable at start gives its call back once it is fixed, but never over a press made meanwhile', async () => {
  const { post, file, restart } = setup({ feeds: [VAN, HOME] });
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const sam = (
      await mint(post, {
        label: 'Sam',
        network: true,
        anytime: false,
        feedId: 'security-van',
      })
    ).revealed.token;
    await post('/contacts', {
      label: 'Mum',
      number: '+15065550100',
      kind: 'other',
    });
    for (const key of [VAN_KEY, HOME_KEY])
      noteUltraPosition({
        key,
        name: key === VAN_KEY ? 'Van 7' : 'Home',
        lat: 45.27,
        lon: -66.06,
        at: Date.now(),
      });
    for (const feedId of ['security-van', 'security-home'])
      assert.equal(
        (await post('/release', { incident: 'threat', feedId })).status,
        200,
      );
    const good = fs.readFileSync(file('ultra-help.json'), 'utf8');
    assert.equal(JSON.parse(good).releases.length, 2);
    // A hand edit leaves a stray comma, and `npm run dev` restarts.
    fs.writeFileSync(file('ultra-help.json'), good.replace(/\}\s*$/, '},'));
    const back = restart();
    const network = async () => (await net(sam)).json().released;
    assert.equal(await network(), false, 'nothing can be known from it yet');
    // Home stands down from its phone meanwhile; the file cannot take it.
    const down = await phone(`/ultra/${HOME_KEY}/help`, {
      method: 'POST',
      headers: JSON_BODY,
      body: { standDown: true },
    });
    assert.equal(down.status, 200, down.text);
    // The owner fixes the comma: the van's call is back at once, and Home's
    // stays down.
    fs.writeFileSync(file('ultra-help.json'), good);
    assert.equal(await network(), true);
    const status = (await back.request('/status')).json();
    assert.deepEqual(
      status.releases.map((item) => item.feedId),
      ['security-van'],
    );
    // The next save keeps the call beside the helpers.
    const added = await back.post('/contacts', {
      label: 'Dad',
      number: '+15065550101',
      kind: 'other',
    });
    assert.equal(added.status, 200, added.text);
    const written = JSON.parse(
      fs.readFileSync(file('ultra-help.json'), 'utf8'),
    );
    assert.deepEqual(
      [written.contacts.length, written.releases.map((item) => item.feedId)],
      [2, ['security-van']],
    );
  } finally {
    console.warn = warn;
    clock.restore();
  }
});

test('a byte-order mark on the helpers file is read, not taken for an empty store', async () => {
  const { post, request, file } = setup();
  fs.writeFileSync(
    file('ultra-help.json'),
    '\uFEFF' +
      JSON.stringify(
        {
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
          releases: [],
        },
        null,
        2,
      ),
  );
  const status = (await request('/status')).json();
  assert.deepEqual(
    status.contacts.map((item) => item.label),
    ['Mum'],
  );
  assert.equal(status.ownerNumber, '+15065550199');
  // The next save keeps them.
  const added = await post('/contacts', {
    label: 'Dad',
    number: '+15065550101',
    kind: 'other',
  });
  assert.equal(added.status, 200, added.text);
  const written = JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8'));
  assert.deepEqual(
    written.contacts.map((item) => item.label),
    ['Mum', 'Dad'],
  );
  assert.equal(written.owner.number, '+15065550199');
});

test('a helpers file that cannot be parsed is never written over, and SEND HELP still goes out', async () => {
  const { post, request, file } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  const good = {
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
    releases: [],
  };
  // A comma too many, as a hand edit leaves it.
  const broken = JSON.stringify(good, null, 2).replace(
    '"kind": "other"\n    }',
    '"kind": "other"\n    },',
  );
  assert.throws(() => JSON.parse(broken));
  fs.writeFileSync(file('ultra-help.json'), broken);
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  try {
    for (const [route, body] of [
      ['/contacts', { label: 'Dad', number: '+15065550101', kind: 'other' }],
      ['/number', { number: '+15065550102' }],
      ['/model', { modelId: 'samsung-s22-ultra' }],
    ]) {
      const refused = await post(route, body);
      assert.equal(refused.status, 409, route);
      assert.equal(
        refused.json().error,
        'Not saved: config/ultra-help.json cannot be read; fix it first (your helpers and number are kept until then)',
      );
    }
    // SEND HELP and STAND DOWN still take effect; the file is left alone,
    // by the presses and by the retry on the status poll.
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    const sent = await post('/release', { incident: 'fire' });
    assert.equal(sent.status, 200, sent.text);
    const down = await post('/release', { standDown: true });
    assert.equal(down.status, 200, down.text);
    assert.deepEqual(down.json().releases, []);
    const again = await post('/release', { incident: 'medical' });
    assert.equal(again.status, 200, again.text);
    clock.tick(15_001);
    await request('/status');
    assert.equal(fs.readFileSync(file('ultra-help.json'), 'utf8'), broken);
    // Said once, and never with the parser's own words.
    const said = warned.filter((line) => line.includes('ultra-help.json'));
    assert.deepEqual(said, [
      '[Ultra help] config/ultra-help.json could not be read; your helpers and number are not changed until it is fixed',
    ]);
    // Fixed by hand: the helpers are back, and the next retry writes the
    // running call into the file beside them.
    fs.writeFileSync(file('ultra-help.json'), JSON.stringify(good, null, 2));
    clock.tick(15_001);
    const status = (await request('/status')).json();
    assert.deepEqual(
      status.contacts.map((item) => item.label),
      ['Mum'],
    );
    const written = JSON.parse(
      fs.readFileSync(file('ultra-help.json'), 'utf8'),
    );
    assert.deepEqual(
      [
        written.contacts.length,
        written.owner.number,
        written.releases.map((item) => item.incident),
      ],
      [1, '+15065550199', ['medical']],
    );
  } finally {
    console.warn = warn;
    clock.restore();
  }
});

test('PUBLISH with two packages: the chosen package decides, and a token of the other is never reused', async () => {
  const { post } = setup({ feeds: [VAN, HOME] });
  noteUltraEndpoint(['https://me.tail9.ts.net']);
  const vague = await post('/network', { publish: true });
  assert.equal(vague.status, 400);
  assert.match(vague.json().error, /^Choose which package to publish/);
  const van = (
    await post('/network', { publish: true, feedId: 'security-van' })
  ).json();
  const vanToken = van.tokens.find(
    (row) => row.id === van.network.published.tokenId,
  );
  assert.equal(vanToken.feedId, 'security-van');
  // DIRECTORY TOKEN for Home: a new token for Home, not the van's again.
  const home = (
    await post('/network', { publish: true, feedId: 'security-home' })
  ).json();
  const homeToken = home.tokens.find(
    (row) => row.id === home.network.published.tokenId,
  );
  assert.equal(homeToken.feedId, 'security-home');
  assert.notEqual(homeToken.id, vanToken.id);
  // …and Home again reuses Home's.
  assert.equal(
    (await post('/network', { publish: true, feedId: 'security-home' })).json()
      .network.published.tokenId,
    homeToken.id,
  );
});

test('a directory pull re-links a hand-added link at its own host, never the one the directory names', async () => {
  await withPeer(async ({ post, file, restart, script, calls }) => {
    // The key file is lost (and there were no tokens to keep it): the link
    // can no longer be opened, so it is not polled until a pull re-links it.
    fs.rmSync(file('ultra-tokens.key'));
    const again = restart();
    noteUltraEndpoint(['https://me.tail9.ts.net']);
    const evil = `https://evil.tail9.ts.net/ultra/help/${PEER_TOKEN}`;
    script((url) => {
      if (url === RAW_URL)
        return json({ version: 1, entries: [{ name: 'Sam', link: evil }] });
      if (url.endsWith('/network')) return json({ released: false });
      return null;
    });
    await withEnv({ ULTRA_DIRECTORY_URL: RAW_URL }, async () => {
      const pulled = await again.post('/network', { update: true });
      assert.equal(pulled.status, 200, pulled.text);
      const row = pulled.json().network.entries[0];
      assert.equal(row.host, 'peer.tail9.ts.net');
      assert.equal(row.directoryDiffers, true);
    });
    calls.length = 0;
    await pollUltraNetworkOnce(Date.now());
    const polled = calls.filter((call) => call.url.endsWith('/network'));
    assert.deepEqual(
      polled.map((call) => new URL(call.url).host),
      ['peer.tail9.ts.net'],
    );
    void post;
  });
});

test('a dev-server restart that loads this module afresh keeps the cards for the phone and the call', async () => {
  const { root, post, poll } = setup();
  const clock = withClock(Date.UTC(2026, 8, 28, 18));
  try {
    await post('/contacts', {
      label: 'Neighbour',
      number: '+15065550100',
      kind: 'other',
    });
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    await post('/release', { incident: 'fire' });
    await poll(Date.now());
    // A POWER UP save restarts the dev server, and Vite evaluates this
    // module again: a second copy, sharing nothing at module level.
    const fresh = await import(
      new URL('../server/providers/ultra-help.js?restart=1', import.meta.url)
        .href
    );
    fresh.ultraHelpProxy({ sourceRoot: root, harden: () => true });
    const url = `/ultra/${VAN_KEY}`;
    const popped = await new Promise((resolve, reject) => {
      Promise.resolve(
        fresh.handleUltraPhone(
          fakeRequest(url, { remoteAddress: HOLDER }),
          fakeResponse(resolve),
          new URL(url, 'http://localhost'),
        ),
      ).catch(reject);
    });
    const body = popped.json();
    assert.equal(body.notify.length, 1);
    assert.equal(body.notify[0].kind, 'sms');
    assert.equal(body.release.incident, 'fire');
  } finally {
    clock.restore();
  }
});

test('a rewritten home-list base is not polled, and a later add does not stamp it', async () => {
  const { post, request, file, calls, script, poll, restart } = setup();
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: PEER_ADDRESS,
        token: PEER_TOKEN,
        name: 'Sam',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: 'http://100.100.1.9',
        token: OTHER_TOKEN,
        name: 'Other',
      })
    ).status,
    200,
  );
  const saved = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  const samMac = saved.entries[0].policyMac;
  assert.match(samMac, /^[0-9a-f]{64}$/);
  saved.entries[0].base = 'https://evil.tail9.ts.net';
  saved.entries[1].lastState = 'tampered';
  fs.writeFileSync(
    file('ultra-network.json'),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
  const back = restart();
  const before = (await back.request('/status')).json();
  assert.equal(
    before.network.entries.find((row) => row.name === 'Sam').lastState,
    'tampered',
  );
  // A stored word 'tampered' on a clean row is not the verdict.
  assert.equal(
    before.network.entries.find((row) => row.name === 'Other').lastState,
    'new',
  );
  script((url) =>
    String(url).endsWith('/network') ? json({ released: false }) : null,
  );
  calls.length = 0;
  await poll(Date.now() + 1000);
  assert.equal(
    calls.some((call) => String(call.url).includes('evil.tail9.ts.net')),
    false,
  );
  assert.equal(
    calls.some((call) => String(call.url).includes('100.100.1.9')),
    true,
  );
  const added = await back.post('/network', {
    add: true,
    address: ANN_ADDRESS,
    token: ANN_TOKEN,
    name: 'Ann',
  });
  assert.equal(added.status, 200, added.text);
  const after = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  const sam = after.entries.find((row) => row.name === 'Sam');
  assert.equal(sam.base, 'https://evil.tail9.ts.net');
  assert.equal(sam.policyMac, samMac);
  assert.equal(
    (await back.request('/status'))
      .json()
      .network.entries.find((row) => row.name === 'Sam').lastState,
    'tampered',
  );
});

test('a home-list entry whose check was removed is not polled, and a later add leaves it removed', async () => {
  const { post, file, calls, script, poll, restart } = setup();
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: PEER_ADDRESS,
        token: PEER_TOKEN,
        name: 'Sam',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: 'http://100.100.1.9',
        token: OTHER_TOKEN,
        name: 'Other',
      })
    ).status,
    200,
  );
  const saved = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  delete saved.entries[0].policyMac;
  fs.writeFileSync(
    file('ultra-network.json'),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
  const back = restart();
  script((url) =>
    String(url).endsWith('/network') ? json({ released: false }) : null,
  );
  calls.length = 0;
  await poll(Date.now() + 1000);
  assert.equal(
    calls.some((call) => String(call.url).includes('peer.tail9.ts.net')),
    false,
  );
  assert.equal(
    calls.some((call) => String(call.url).includes('100.100.1.9')),
    true,
  );
  assert.equal(
    (await back.request('/status'))
      .json()
      .network.entries.find((row) => row.name === 'Sam').lastState,
    'tampered',
  );
  assert.equal(
    (
      await back.post('/network', {
        add: true,
        address: ANN_ADDRESS,
        token: ANN_TOKEN,
        name: 'Ann',
      })
    ).status,
    200,
  );
  const after = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  assert.equal(
    'policyMac' in after.entries.find((row) => row.name === 'Sam'),
    false,
  );
  calls.length = 0;
  await poll(Date.now() + 1000);
  assert.equal(
    calls.some((call) => String(call.url).includes('peer.tail9.ts.net')),
    false,
  );
});

test('a home list with no check is still polled, and the next rename stamps it', async () => {
  const { post, request, file, calls, script, poll, restart } = setup();
  const added = await post('/network', {
    add: true,
    address: PEER_ADDRESS,
    token: PEER_TOKEN,
    name: 'Sam',
  });
  assert.equal(added.status, 200, added.text);
  const id = added.json().network.entries[0].id;
  const saved = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  delete saved.entries[0].policyMac;
  fs.writeFileSync(
    file('ultra-network.json'),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
  restart();
  script((url) =>
    String(url).endsWith('/network') ? json({ released: false }) : null,
  );
  calls.length = 0;
  // The reload stamps the first poll a moment after this call's clock, so
  // the due time has to sit past that stamp or a fast machine skips the row.
  await poll(Date.now() + 1000);
  assert.equal(
    calls.some((call) => String(call.url).includes('peer.tail9.ts.net')),
    true,
  );
  const renamed = await post('/network', {
    rename: true,
    id,
    name: 'Sam next door',
  });
  assert.equal(renamed.status, 200, renamed.text);
  const after = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  assert.match(after.entries[0].policyMac, /^[0-9a-f]{64}$/);
  assert.equal(
    (await request('/status')).json().network.entries[0].lastState ===
      'tampered',
    false,
  );
});

test('wiping every home-list check and changing the base is still polled', async () => {
  const { post, file, calls, script, poll, restart } = setup();
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: PEER_ADDRESS,
        token: PEER_TOKEN,
        name: 'Sam',
      })
    ).status,
    200,
  );
  const saved = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  delete saved.entries[0].policyMac;
  saved.entries[0].base = 'https://evil.tail9.ts.net';
  fs.writeFileSync(
    file('ultra-network.json'),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
  restart();
  script((url) =>
    String(url).endsWith('/network') ? json({ released: false }) : null,
  );
  calls.length = 0;
  await poll(Date.now() + 1000);
  assert.equal(
    calls.some((call) => String(call.url).includes('evil.tail9.ts.net')),
    true,
  );
});

test('a same-id home-list row pasted above the real one is not fetched', async () => {
  const { post, file, calls, script, poll, restart } = setup();
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: PEER_ADDRESS,
        token: PEER_TOKEN,
        name: 'Sam',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: 'http://100.100.1.9',
        token: OTHER_TOKEN,
        name: 'Other',
      })
    ).status,
    200,
  );
  const saved = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  saved.entries.unshift({
    ...saved.entries[0],
    base: 'https://evil.tail9.ts.net',
  });
  fs.writeFileSync(
    file('ultra-network.json'),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
  const back = restart();
  script((url) =>
    String(url).endsWith('/network') ? json({ released: false }) : null,
  );
  calls.length = 0;
  await poll(Date.now() + 1000);
  assert.equal(
    calls.some((call) => String(call.url).includes('evil.tail9.ts.net')),
    false,
  );
  assert.equal(
    calls.some((call) => String(call.url).includes('100.100.1.9')),
    true,
  );
  const rows = (await back.request('/status')).json().network.entries;
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.name === 'Sam').lastState, 'tampered');
});

test('a new id with a copied home-list seal is not fetched', async () => {
  const { post, file, calls, script, poll, restart } = setup();
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: PEER_ADDRESS,
        token: PEER_TOKEN,
        name: 'Sam',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: 'http://100.100.1.9',
        token: OTHER_TOKEN,
        name: 'Other',
      })
    ).status,
    200,
  );
  const saved = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  saved.entries.unshift({
    ...saved.entries[0],
    id: 'n-ffffffffffffffff',
    base: 'https://evil.tail9.ts.net',
  });
  fs.writeFileSync(
    file('ultra-network.json'),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
  const back = restart();
  script((url) =>
    String(url).endsWith('/network') ? json({ released: false }) : null,
  );
  calls.length = 0;
  await poll(Date.now() + 1000);
  assert.equal(
    calls.some((call) => String(call.url).includes('evil.tail9.ts.net')),
    false,
  );
  assert.equal(
    calls.some((call) => String(call.url).includes('peer.tail9.ts.net')),
    false,
  );
  const rows = (await back.request('/status')).json().network.entries;
  assert.equal(
    rows.some((row) => row.name === 'Sam' && row.host === 'peer.tail9.ts.net'),
    false,
  );
  assert.equal(
    rows.find((row) => row.host === 'evil.tail9.ts.net').lastState,
    'tampered',
  );
});

test('a rewritten base is not polled while a call for help is still running', async () => {
  const { post, file, calls, script, poll, restart } = setup();
  assert.equal(
    (
      await post('/network', {
        add: true,
        address: PEER_ADDRESS,
        token: PEER_TOKEN,
        name: 'Sam',
      })
    ).status,
    200,
  );
  script((url) => (url === PEER_NETWORK ? releasedBody() : null));
  await poll(Date.now());
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const saved = JSON.parse(fs.readFileSync(file('ultra-network.json'), 'utf8'));
  saved.entries[0].base = 'https://evil.tail9.ts.net';
  fs.writeFileSync(
    file('ultra-network.json'),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
  restart();
  calls.length = 0;
  script((url) =>
    String(url).includes('evil.tail9.ts.net') ? releasedBody() : null,
  );
  await poll(Date.now() + 1000);
  assert.equal(
    calls.some((call) => String(call.url).includes('evil.tail9.ts.net')),
    false,
  );
});

test('a helpers file with no check is used, and a bad check is not', async () => {
  const world = setup();
  const { post, request, file, calls } = world;
  fs.writeFileSync(
    file('ultra-help.json'),
    `${JSON.stringify({
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
      releases: [],
    })}\n`,
  );
  const legacy = (await request('/status')).json();
  assert.equal(legacy.contacts[0].label, 'Mum');
  assert.equal(legacy.ownerNumber, '+15065550199');
  assert.equal(legacy.helpStore, 'ok');
  assert.equal('policyMac' in legacy, false);
  const minted = await mint(post);
  const token = minted.revealed.token;
  const still = (await request('/status')).json();
  assert.equal(still.contacts[0].label, 'Mum');
  assert.equal(still.helpStore, 'ok');
  await askForHelp(post);
  // A holder is never shown the number or the file's state: the poll
  // carries the call and nothing else.
  const holder = (await net(token)).json();
  assert.equal(holder.released, true);
  assert.equal(JSON.stringify(holder).includes('+15065550199'), false);
  assert.equal('helpStore' in holder, false);
  const stamped = await post('/number', { number: '+15065550199' });
  assert.equal(stamped.status, 200, stamped.text);
  const raw = JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8'));
  assert.match(raw.policyMac, /^[0-9a-f]{64}$/);
  raw.contacts[0].number = '+15065550177';
  raw.owner.number = '+15065550177';
  fs.writeFileSync(
    file('ultra-help.json'),
    `${JSON.stringify(raw, null, 2)}\n`,
  );
  const tampered = (await request('/status')).json();
  assert.deepEqual(tampered.contacts, []);
  assert.equal(tampered.ownerNumber, '');
  assert.equal(tampered.helpStore, 'tampered');
  assert.equal(
    JSON.stringify((await net(token)).json()).includes('+15065550177'),
    false,
  );
  await withEnv(
    {
      ULTRA_SMS_RELAY_URL: 'https://sms.example/send',
      ULTRA_SMS_RELAY_TOKEN: 'gateway-fixture',
    },
    async () => {
      const seen = calls.length;
      const tested = await post('/network', { testSms: true });
      assert.equal(tested.status, 409);
      assert.match(tested.text, /SAVE MY #/);
      assert.equal(calls.length, seen);
    },
  );
  const replaced = await post('/contacts', {
    label: 'Dad',
    number: '+15065550101',
    kind: 'other',
  });
  assert.equal(replaced.status, 200, replaced.text);
  assert.equal(replaced.json().helpStore, 'ok');
  assert.deepEqual(
    replaced.json().contacts.map((item) => item.label),
    ['Dad'],
  );
  const written = JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8'));
  assert.deepEqual(
    written.contacts.map((item) => item.number),
    ['+15065550101'],
  );
  assert.equal(written.owner.number, '');
  assert.match(written.policyMac, /^[0-9a-f]{64}$/);
  assert.equal(
    written.contacts.some((item) => item.number === '+15065550177'),
    false,
  );
});

test('a planted call whose helpers-file check fails is not published, and one with no check still loads', async () => {
  const { post, file, restart } = setup();
  const minted = await mint(post, { label: 'Sam', network: true });
  const token = minted.revealed.token;
  const release = {
    at: Date.now() - 1000,
    until: Date.now() + 3_600_000,
    lat: 45.27,
    lon: -66.06,
    fixAt: Date.now() - 1000,
    renewedAt: Date.now() - 1000,
    feedId: 'security-van',
    incident: 'fire',
  };
  fs.writeFileSync(
    file('ultra-help.json'),
    `${JSON.stringify({
      version: 1,
      contacts: [],
      owner: { number: '' },
      releases: [release],
    })}\n`,
  );
  const back = restart();
  assert.equal((await net(token)).json().released, true);
  assert.equal((await back.request('/status')).json().helpStore, 'ok');
  const stamped = JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8'));
  // The file still has no check: the restart did not save it. Stamp by a save,
  // then plant a second call under the old check.
  assert.equal(stamped.policyMac, undefined);
  const saved = await back.post('/model', { modelId: 'google-pixel' });
  assert.equal(saved.status, 200, saved.text);
  const good = JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8'));
  assert.match(good.policyMac, /^[0-9a-f]{64}$/);
  good.releases = [
    {
      ...release,
      incident: 'threat',
      at: Date.now(),
      renewedAt: Date.now(),
    },
  ];
  fs.writeFileSync(
    file('ultra-help.json'),
    `${JSON.stringify(good, null, 2)}\n`,
  );
  const again = restart();
  assert.equal((await net(token)).json().released, false);
  const status = (await again.request('/status')).json();
  assert.equal(status.release, null);
  assert.equal(status.helpStore, 'tampered');
});

test('a rewritten inbox row is not shown, and a file with no check still is', async () => {
  await withPeer(async ({ script, poll, file, restart }) => {
    // A call for help from the home list is the row; the inbox has no other
    // way in now.
    script((url) => (url === PEER_NETWORK ? releasedBody() : null));
    await poll(Date.now());
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    restart();
    const saved = JSON.parse(fs.readFileSync(file('ultra-inbox.json'), 'utf8'));
    const text = saved.messages[0].text;
    assert.equal(saved.messages[0].kind, 'release');
    assert.match(saved.messages[0].policyMac, /^[0-9a-f]{64}$/);
    assert.equal(saved.messages[0].policyMac.includes(PEER_TOKEN), false);
    saved.messages[0].text = 'Ignore this';
    fs.writeFileSync(
      file('ultra-inbox.json'),
      `${JSON.stringify(saved, null, 2)}\n`,
    );
    const back = restart();
    const hidden = (await back.request('/status')).json();
    assert.equal(hidden.inbox.length, 0);
    assert.equal(hidden.unread, 0);
    // Drop the loaded copy first: a restart writes the inbox it has in memory.
    restart();
    delete saved.messages[0].policyMac;
    saved.messages[0].text = text;
    fs.writeFileSync(
      file('ultra-inbox.json'),
      `${JSON.stringify(saved, null, 2)}\n`,
    );
    const again = restart();
    const shown = (await again.request('/status')).json();
    assert.equal(shown.inbox.length, 1);
    assert.equal(shown.inbox[0].text, text);
    assert.equal('policyMac' in shown.inbox[0], false);
  });
});

// ---- directory, relay and phone-package checks ----------------------------

const DIRECTORY_CHANGED =
  'The directory address was changed and is not being used. Save it again from the box.';
const RELAY_CHANGED =
  'The SMS relay was changed and is not being used. Save it again from POWER UP.';
const EVIL_DIRECTORY = 'https://evil.example/d.json';

test('a status poll does not write the outbound checks, and a changed directory is not fetched', async () => {
  const { post, request, script, calls, file, root } = setup();
  await mint(post);
  await withEnv(
    {
      ULTRA_DIRECTORY_URL: RAW_URL,
      ULTRA_DIRECTORY_WRITE_TOKEN: 'github_pat_fixture',
    },
    async () => {
      const status = await request('/status');
      assert.equal(status.status, 200);
      assert.equal(fs.existsSync(file('ultra-outbound.json')), false);
      const stores = status.json();
      assert.equal(stores.directoryStore, 'ok');
      assert.equal(stores.relayStore, 'ok');
      assert.equal(stores.feedsStore, 'ok');
      script((url) =>
        url === RAW_URL || url === EVIL_DIRECTORY
          ? json({
              version: 1,
              entries: [
                { name: 'Sam', address: PEER_ADDRESS, token: PEER_TOKEN },
              ],
            })
          : null,
      );
      const pulled = await post('/network', { update: true });
      assert.equal(pulled.status, 200, pulled.text);
      assert.equal(
        calls.some((call) => call.url === RAW_URL),
        true,
      );
      // A relay check beside no directory check leaves the directory trusted.
      noteOutboundEnvSaved(['ULTRA_SMS_RELAY_URL'], root);
      const relayOnly = JSON.parse(
        fs.readFileSync(file('ultra-outbound.json'), 'utf8'),
      );
      assert.match(relayOnly.relayMac, /^[0-9a-f]{64}$/);
      assert.equal('directoryMac' in relayOnly, false);
      process.env.ULTRA_DIRECTORY_URL = EVIL_DIRECTORY;
      const legacy = await post('/network', { update: true });
      assert.equal(legacy.status, 200, legacy.text);
      assert.equal(
        calls.some((call) => call.url === EVIL_DIRECTORY),
        true,
      );
      process.env.ULTRA_DIRECTORY_URL = RAW_URL;
      noteOutboundEnvSaved(['ULTRA_DIRECTORY_URL'], root);
      const text = fs.readFileSync(file('ultra-outbound.json'), 'utf8');
      const stamped = JSON.parse(text);
      assert.match(stamped.directoryMac, /^[0-9a-f]{64}$/);
      assert.equal(stamped.relayMac, relayOnly.relayMac);
      assert.equal(text.includes(RAW_URL), false);
      assert.equal(text.includes('github_pat_fixture'), false);
      assert.equal(text.includes('https://'), false);
      const poked = JSON.parse(text);
      poked.directoryMac = 'nope';
      fs.writeFileSync(
        file('ultra-outbound.json'),
        `${JSON.stringify(poked, null, 2)}\n`,
      );
      const atBad = calls.length;
      const badMac = await post('/network', { update: true });
      assert.equal(badMac.status, 409);
      assert.equal(badMac.json().error, DIRECTORY_CHANGED);
      assert.equal(calls.length, atBad);
      noteOutboundEnvSaved(['ULTRA_DIRECTORY_URL'], root);
      process.env.ULTRA_DIRECTORY_URL = EVIL_DIRECTORY;
      const at = calls.length;
      const refused = await post('/network', { update: true });
      assert.equal(refused.status, 409);
      assert.equal(refused.json().error, DIRECTORY_CHANGED);
      assert.equal(calls.length, at);
      const count = JSON.parse(
        fs.readFileSync(file('ultra-tokens.json'), 'utf8'),
      ).tokens.length;
      const published = await post('/network', { publish: true });
      assert.equal(published.status, 409);
      assert.equal(published.json().error, DIRECTORY_CHANGED);
      assert.equal(published.text.includes('uht1.'), false);
      assert.equal(calls.length, at);
      assert.equal(
        JSON.parse(fs.readFileSync(file('ultra-tokens.json'), 'utf8')).tokens
          .length,
        count,
      );
      fs.unlinkSync(file('ultra-outbound.json'));
      const again = await post('/network', { update: true });
      assert.equal(again.status, 200, again.text);
      assert.equal(
        calls.slice(at).some((call) => call.url === EVIL_DIRECTORY),
        true,
      );
    },
  );
});

test('a missing or unusable token key does not write an outbound check', async () => {
  const missing = setup();
  await withEnv({ ULTRA_DIRECTORY_URL: RAW_URL }, async () => {
    noteOutboundEnvSaved(['ULTRA_DIRECTORY_URL'], missing.root);
    assert.equal(fs.existsSync(missing.file('ultra-outbound.json')), false);
    assert.equal(
      (await missing.request('/status')).json().directoryStore,
      'ok',
    );
  });
  const invalid = setup();
  fs.writeFileSync(invalid.file('ultra-tokens.key'), 'not-a-key\n');
  await withEnv({ ULTRA_DIRECTORY_URL: RAW_URL }, async () => {
    noteOutboundEnvSaved(['ULTRA_DIRECTORY_URL'], invalid.root);
    assert.equal(fs.existsSync(invalid.file('ultra-outbound.json')), false);
    assert.equal(
      (await invalid.request('/status')).json().directoryStore,
      'ok',
    );
  });
  // A check already on disk is dropped, so the new value is not stuck closed.
  const minted = setup();
  await mint(minted.post);
  await withEnv({ ULTRA_DIRECTORY_URL: RAW_URL }, async () => {
    noteOutboundEnvSaved(['ULTRA_DIRECTORY_URL'], minted.root);
    fs.writeFileSync(minted.file('ultra-tokens.key'), 'not-a-key\n');
    noteOutboundEnvSaved(['ULTRA_DIRECTORY_URL'], minted.root);
    const saved = JSON.parse(
      fs.readFileSync(minted.file('ultra-outbound.json'), 'utf8'),
    );
    assert.equal(saved.version, 1);
    assert.equal('directoryMac' in saved, false);
    minted.script((url) =>
      url === RAW_URL
        ? json({
            version: 1,
            entries: [
              { name: 'Sam', address: PEER_ADDRESS, token: PEER_TOKEN },
            ],
          })
        : null,
    );
    const pulled = await minted.post('/network', { update: true });
    assert.notEqual(pulled.json().error, DIRECTORY_CHANGED);
    assert.equal(
      minted.calls.some((call) => call.url === RAW_URL),
      true,
    );
  });
});

test('an unreadable outbound file is not used, and the next save replaces it', async () => {
  const { post, request, file, root } = setup();
  await mint(post);
  fs.writeFileSync(file('ultra-outbound.json'), '{');
  const broken = (await request('/status')).json();
  assert.equal(broken.directoryStore, 'tampered');
  assert.equal(broken.relayStore, 'tampered');
  assert.equal(broken.feedsStore, 'tampered');
  await withEnv({ ULTRA_DIRECTORY_URL: RAW_URL }, async () => {
    noteOutboundEnvSaved(['ULTRA_DIRECTORY_URL'], root);
    const text = fs.readFileSync(file('ultra-outbound.json'), 'utf8');
    const saved = JSON.parse(text);
    assert.match(saved.directoryMac, /^[0-9a-f]{64}$/);
    assert.equal('relayMac' in saved, false);
    assert.equal(text.includes(RAW_URL), false);
    const fixed = (await request('/status')).json();
    assert.equal(fixed.directoryStore, 'ok');
    assert.equal(fixed.feedsStore, 'ok');
  });
});

test('a changed SMS relay is not used, and deleting its check sends again', async () => {
  const gateway = 'https://sms.example/send';
  const evil = 'https://evil.example/send';
  await withEnv(
    {
      ...TWILIO,
      ULTRA_SMS_RELAY_URL: gateway,
      ULTRA_SMS_RELAY_TOKEN: 'gateway-fixture',
    },
    async () => {
      const { post, request, script, calls, file, root } = setup();
      const clock = withClock(Date.UTC(2026, 8, 30, 12));
      try {
        await mint(post);
        await post('/number', { number: '+15065550199' });
        noteOutboundEnvSaved(
          [
            'ULTRA_SMS_RELAY_URL',
            'ULTRA_SMS_RELAY_TOKEN',
            'TWILIO_ACCOUNT_SID',
            'TWILIO_AUTH_TOKEN',
            'TWILIO_FROM_NUMBER',
          ],
          root,
        );
        const text = fs.readFileSync(file('ultra-outbound.json'), 'utf8');
        const saved = JSON.parse(text);
        assert.match(saved.relayMac, /^[0-9a-f]{64}$/);
        assert.equal('directoryMac' in saved, false);
        assert.equal(text.includes('auth-fixture'), false);
        assert.equal(text.includes('gateway-fixture'), false);
        assert.equal(text.includes(gateway), false);
        assert.equal(text.includes(`AC${'f'.repeat(32)}`), false);
        script((url) =>
          url === TWILIO_URL || url === gateway || url === evil
            ? json({ ok: true })
            : null,
        );
        const tested = await post('/network', { testSms: true });
        assert.equal(tested.status, 200, tested.text);
        await flush();
        assert.equal(
          calls.some((call) => call.url === TWILIO_URL),
          true,
        );
        const sent = calls.length;
        const testedAt = (await request('/status')).json().network.relay
          .lastTestAt;
        noteOutboundEnvSaved(['OPENAI_API_KEY'], root);
        assert.equal(
          fs.readFileSync(file('ultra-outbound.json'), 'utf8'),
          text,
        );
        process.env.ULTRA_SMS_RELAY_URL = evil;
        const refused = await post('/network', { testSms: true });
        assert.equal(refused.status, 409);
        assert.equal(refused.json().error, RELAY_CHANGED);
        assert.equal(calls.length, sent);
        assert.equal(
          (await request('/status')).json().network.relay.lastTestAt,
          testedAt,
        );
        assert.equal((await request('/status')).json().relayStore, 'tampered');
        fs.unlinkSync(file('ultra-outbound.json'));
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;
        delete process.env.TWILIO_FROM_NUMBER;
        clock.tick(600_000);
        const again = await post('/network', { testSms: true });
        assert.equal(again.status, 200, again.text);
        await flush();
        assert.equal(
          calls.some((call) => call.url === evil),
          true,
        );
        assert.equal((await request('/status')).json().relayStore, 'ok');
      } finally {
        clock.restore();
      }
    },
  );
});

test('a replaced token key still sends until a token is minted under it', async () => {
  await withEnv(TWILIO, async () => {
    const { post, request, script, calls, file, root } = setup();
    const clock = withClock(Date.UTC(2026, 8, 30, 15));
    try {
      await mint(post);
      await post('/number', { number: '+15065550199' });
      noteOutboundEnvSaved(
        ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
        root,
      );
      script((url) => (url === TWILIO_URL ? json({ ok: true }) : null));
      assert.equal((await post('/network', { testSms: true })).status, 200);
      await flush();
      assert.equal(
        calls.some((call) => call.url === TWILIO_URL),
        true,
      );
      fs.writeFileSync(file('ultra-tokens.key'), otherKeyText(7));
      assert.equal((await request('/status')).json().relayStore, 'ok');
      assert.equal((await request('/status')).json().tokenStore, 'key-changed');
      clock.tick(600_000);
      calls.length = 0;
      const still = await post('/network', { testSms: true });
      assert.equal(still.status, 200, still.text);
      await flush();
      assert.equal(
        calls.some((call) => call.url === TWILIO_URL),
        true,
      );
      await mint(post);
      // The new seal opens, so the relay check from the old key fails closed.
      // The helpers file fails closed with it, and TEST SMS asks for the
      // number before it asks the relay, so the number is saved again first.
      assert.equal((await request('/status')).json().relayStore, 'tampered');
      await post('/number', { number: '+15065550199' });
      calls.length = 0;
      const closed = await post('/network', { testSms: true });
      assert.equal(closed.status, 409);
      assert.equal(closed.json().error, RELAY_CHANGED);
      assert.equal(calls.length, 0);
      noteOutboundEnvSaved(['TWILIO_ACCOUNT_SID'], root);
      clock.tick(600_000);
      const resent = await post('/network', { testSms: true });
      assert.equal(resent.status, 200, resent.text);
      await flush();
      assert.equal(
        calls.some((call) => call.url === TWILIO_URL),
        true,
      );
    } finally {
      clock.restore();
    }
  });
});

test('a changed phone package is not admitted, and a place-only edit still is', async () => {
  const { post, request, root, file } = setup();
  const token = (await mint(post)).revealed.token;
  noteSecurityFeedsSaved({ version: 1, feeds: [VAN] }, root);
  const side = fs.readFileSync(file('ultra-outbound.json'), 'utf8');
  assert.match(JSON.parse(side).feedsMac, /^[0-9a-f]{64}$/);
  assert.equal(side.includes(VAN_KEY), false);
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 200);
  noteUltraPosition({
    key: VAN_KEY,
    name: 'Van 7',
    lat: 45.27,
    lon: -66.06,
    at: Date.now(),
  });
  const released = await post('/release', { incident: 'fire' });
  assert.equal(released.status, 200, released.text);
  writeFeeds(root, [{ ...VAN, url: 'https://evil.example/pos' }]);
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 404);
  const hidden = (await request('/status')).json();
  assert.equal(hidden.feedsStore, 'tampered');
  assert.equal(hidden.release.incident, 'fire');
  const other = 'z'.repeat(43);
  writeFeeds(root, [{ ...VAN, reportKey: other }]);
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 404);
  assert.equal((await phone(`/ultra/${other}`)).status, 404);
  writeFeeds(root, [VAN]);
  noteSecurityFeedsSaved({ version: 1, feeds: [VAN] }, root);
  writeFeeds(root, [{ ...VAN, lat: 46.1, lon: -67 }]);
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 200);
  assert.equal((await request('/status')).json().feedsStore, 'ok');
  writeFeeds(root, [
    VAN,
    {
      id: 'tracker-van',
      kind: 'tracker',
      name: 'Van',
      method: 'traccar',
      url: 'https://gps.example/api/positions',
    },
  ]);
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 200);
  writeFeeds(root, []);
  noteSecurityFeedsSaved({ version: 1, feeds: [] }, root);
  writeFeeds(root, [VAN]);
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 404);
  noteSecurityFeedsSaved({ version: 1, feeds: [VAN] }, root);
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 200);
  writeFeeds(root, [{ ...VAN, url: 'https://evil.example/pos' }]);
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 404);
  fs.unlinkSync(file('ultra-outbound.json'));
  assert.equal((await phone(`/ultra/${VAN_KEY}`)).status, 200);
  await withEnv(
    { ULTRA_DIRECTORY_URL: RAW_URL, ULTRA_DIRECTORY_WRITE_TOKEN: undefined },
    async () => {
      noteOutboundEnvSaved(['ULTRA_DIRECTORY_URL'], root);
      process.env.ULTRA_DIRECTORY_URL = EVIL_DIRECTORY;
      const owner = (await request('/status')).json();
      assert.equal(owner.directoryStore, 'tampered');
      assert.equal(owner.feedsStore, 'ok');
      const holder = await net(token);
      assert.equal(holder.status, 200, holder.text);
      const keys = Object.keys(holder.json());
      assert.equal(keys.includes('directoryStore'), false);
      assert.equal(keys.includes('relayStore'), false);
      assert.equal(keys.includes('feedsStore'), false);
    },
  );
});

test('each package has its own picture and live view; the bare ones follow the newest phone', async () => {
  const { plugin } = setup({ feeds: [VAN, HOME] });
  const uses = [];
  plugin.configureServer({
    middlewares: { use: (...args) => uses.push(args) },
  });
  const handler = uses.find((args) => args[0] === '/api/ultra-help')[1];
  const get = (url) =>
    new Promise((resolve, reject) => {
      Promise.resolve(handler(fakeRequest(url), fakeResponse(resolve))).catch(
        reject,
      );
    });
  // A live viewer stays open: it collects what it is sent until it closes.
  const watch = (url) => {
    const sent = [];
    const closers = [];
    const req = fakeRequest(url);
    req.socket.setTimeout = () => {};
    const res = {
      headersSent: false,
      status: 0,
      headers: {},
      writeHead(status, headers = {}) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      setTimeout() {},
      write(chunk) {
        sent.push(Buffer.from(chunk).toString('utf8'));
        return true;
      },
      on(event, fn) {
        if (event === 'close') closers.push(fn);
      },
      once() {},
      end() {},
    };
    handler(req, res);
    return {
      res,
      text: () => sent.join(''),
      close: () => closers.forEach((fn) => fn()),
    };
  };
  // A JPEG's first bytes, then a label the assertions can find.
  const upload = (key, text) =>
    phone(`/ultra/${key}/picture`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.concat([JPEG_START, Buffer.from(text)]),
    });

  assert.equal((await get('/picture/device-security-van')).status, 404);
  assert.equal((await get('/live/device-nobody')).status, 404);
  const vanLive = watch('/live/device-security-van');
  const anyLive = watch('/live');
  assert.equal(vanLive.res.status, 200);
  try {
    assert.equal((await upload(VAN_KEY, 'VAN-FRAME-1')).status, 200);
    assert.equal((await upload(HOME_KEY, 'HOME-FRAME-1')).status, 200);
    // Each package's card gets its own phone's picture.
    const vanPicture = await get('/picture/device-security-van');
    assert.ok(vanPicture.text.endsWith('VAN-FRAME-1'));
    assert.equal(vanPicture.headers['Content-Type'], 'image/jpeg');
    assert.equal(
      vanPicture.headers['Cross-Origin-Resource-Policy'],
      'same-origin',
    );
    assert.ok(
      (await get('/picture/device-security-home')).text.endsWith(
        'HOME-FRAME-1',
      ),
    );
    assert.equal((await get('/picture/device-nobody')).status, 404);
    // A package's live view carries its phone alone; the bare one, every phone.
    assert.ok(vanLive.text().includes('VAN-FRAME-1'));
    assert.equal(vanLive.text().includes('HOME-FRAME-1'), false);
    assert.ok(anyLive.text().includes('VAN-FRAME-1'));
    assert.ok(anyLive.text().includes('HOME-FRAME-1'));
    // The bare picture is the phone that reported its position last.
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now() - 1000,
    });
    noteUltraPosition({
      key: HOME_KEY,
      name: 'Home',
      lat: 45.3,
      lon: -66.1,
      at: Date.now(),
    });
    assert.ok((await get('/picture')).text.endsWith('HOME-FRAME-1'));
    // A viewer that joins late is sent its own phone's last frame at once.
    const lateVan = watch('/live/device-security-van');
    assert.ok(lateVan.text().includes('VAN-FRAME-1'));
    assert.equal(lateVan.text().includes('HOME-FRAME-1'), false);
    lateVan.close();
  } finally {
    vanLive.close();
    anyLive.close();
  }
});

/** The owner route's handler, for GETs from the page. */
function ownerRoute(plugin) {
  const uses = [];
  plugin.configureServer({
    middlewares: { use: (...args) => uses.push(args) },
  });
  const handler = uses.find((args) => args[0] === '/api/ultra-help')[1];
  const get = (url) =>
    new Promise((resolve, reject) => {
      Promise.resolve(handler(fakeRequest(url), fakeResponse(resolve))).catch(
        reject,
      );
    });
  return { handler, get };
}

test('a picture is served as the type its bytes are, never a type list the phone sent', async () => {
  const { plugin } = setup();
  const { get } = ownerRoute(plugin);
  const send = (type, body) =>
    phone(`/ultra/${VAN_KEY}/picture`, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('PNG-FRAME'),
  ]);
  const HTML = Buffer.from(
    '<form action="https://evil.example/"><button>Sign in</button></form>',
  );
  // A list of types (browsers take the last), a page sent as a picture, a
  // type that is not one of the three: refused, and nothing is kept.
  for (const [type, body] of [
    ['image/png, text/html', PNG],
    ['image/png,text/html', PNG],
    ['image/png', HTML],
    ['image/jpeg', Buffer.from([0xff, 0xd8])],
    ['text/html', PNG],
    ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['', PNG],
  ]) {
    assert.equal((await send(type, body)).status, 415, type);
  }
  assert.equal((await get('/picture/device-security-van')).status, 404);
  // Among the three, the bytes decide: a PNG said to be a JPEG is a PNG.
  assert.equal((await send('Image/JPEG; q=0.5', PNG)).status, 200);
  const served = await get('/picture/device-security-van');
  assert.equal(served.headers['Content-Type'], 'image/png');
  assert.equal(served.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(served.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.ok(served.text.endsWith('PNG-FRAME'));
  const WEBP = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBPVP8 '),
  ]);
  assert.equal((await send('image/webp', WEBP)).status, 200);
  assert.equal(
    (await get('/picture/device-security-van')).headers['Content-Type'],
    'image/webp',
  );
});

test('picture uploads: twenty-five a second from one phone, then a wait', async () => {
  setup();
  const clock = withClock(Date.UTC(2026, 9, 1, 12));
  const frame = () =>
    phone(`/ultra/${VAN_KEY}/picture`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.concat([JPEG_START, Buffer.from('FRAME')]),
    });
  try {
    for (let i = 0; i < 25; i += 1)
      assert.equal((await frame()).status, 200, `frame ${i + 1}`);
    const flooded = await frame();
    assert.deepEqual([flooded.status, flooded.text], [429, 'Wait']);
    clock.tick(1001);
    assert.equal((await frame()).status, 200);
  } finally {
    clock.restore();
  }
});

test('a live viewer that stops reading skips frames, is never sent part of one, and the oldest of too many is closed', async () => {
  const { plugin } = setup();
  const { handler } = ownerRoute(plugin);
  const watch = (url) => {
    const viewer = { sent: [], drains: [], flowing: true, ended: false };
    const req = fakeRequest(url);
    req.socket.setTimeout = () => {};
    req.on = () => {};
    const res = {
      headersSent: false,
      writeHead(status) {
        Object.assign(this, { status, headersSent: true });
      },
      setTimeout() {},
      write(chunk) {
        viewer.sent.push(Buffer.from(chunk));
        return viewer.flowing;
      },
      on() {},
      once(event, fn) {
        if (event === 'drain') viewer.drains.push(fn);
      },
      end() {
        viewer.ended = true;
      },
    };
    handler(req, res);
    viewer.text = () => Buffer.concat(viewer.sent).toString('latin1');
    viewer.drain = () => {
      viewer.flowing = true;
      viewer.drains.splice(0).forEach((fn) => fn());
    };
    return viewer;
  };
  const upload = (label) =>
    phone(`/ultra/${VAN_KEY}/picture`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.concat([JPEG_START, Buffer.from(label)]),
    });
  const slow = watch('/live/device-security-van');
  assert.equal((await upload('FRAME-1')).status, 200);
  // The socket's buffer fills: the frame being written is still finished...
  slow.flowing = false;
  assert.equal((await upload('FRAME-2')).status, 200);
  // ...and the next ones are skipped until it drains.
  assert.equal((await upload('FRAME-3')).status, 200);
  assert.equal((await upload('FRAME-4')).status, 200);
  slow.drain();
  assert.equal((await upload('FRAME-5')).status, 200);
  const text = slow.text();
  for (const label of ['FRAME-1', 'FRAME-2', 'FRAME-5'])
    assert.ok(text.includes(label), label);
  for (const label of ['FRAME-3', 'FRAME-4'])
    assert.equal(text.includes(label), false, label);
  // Every part is whole: a boundary, its headers, exactly its bytes, CRLF.
  const parts = text.split('--gev-ultra\r\n').slice(1);
  assert.equal(parts.length, 3);
  for (const part of parts) {
    const [head, body] = part.split('\r\n\r\n');
    const length = Number(/Content-Length: (\d+)/.exec(head)[1]);
    assert.equal(head.includes('Content-Type: image/jpeg'), true);
    assert.equal(body.length, length + 2, 'the frame, then CRLF');
    assert.ok(body.endsWith('\r\n'));
  }
  // Sixteen views at once: the seventeenth closes the oldest.
  const others = [];
  for (let i = 0; i < 15; i += 1) others.push(watch('/live'));
  assert.equal(slow.ended, false);
  const newest = watch('/live');
  assert.equal(slow.ended, true, 'the oldest view is closed');
  assert.equal(
    others.some((viewer) => viewer.ended),
    false,
  );
  assert.equal((await upload('FRAME-6')).status, 200);
  assert.ok(newest.text().includes('FRAME-6'));
  assert.equal(slow.text().includes('FRAME-6'), false);
});

test('Find Ultra Help is under development: no search, no send, and no search result in the status', async () => {
  const { post, request, calls } = setup();
  noteUltraPosition({
    key: VAN_KEY,
    name: 'Van 7',
    lat: 45.27,
    lon: -66.06,
    at: Date.now(),
  });
  const before = calls.length;
  assert.equal((await post('/incident', { type: 'fire' })).status, 404);
  assert.equal(
    (await post('/send', { numbers: ['+15065550111'] })).status,
    404,
  );
  // Nothing was looked up for it: no geocoder, no station search.
  assert.equal(calls.length, before);
  const status = (await request('/status')).json();
  for (const field of [
    'review',
    'matches',
    'message',
    'searched',
    'emergency',
    'lookupOk',
  ])
    assert.equal(field in status, false, field);
});

test('HELP DELIVERY: SEND HELP asks for the saved needs, and holders receive them', async () => {
  const { post } = setup();
  const clock = withClock(Date.UTC(2026, 9, 4, 18));
  try {
    assert.equal(
      (await post('/needs', { needs: { kind: 'spaceship' } })).status,
      400,
    );
    const saved = await post('/needs', {
      needs: { kind: 'transportation', destination: 'hospital' },
    });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json().ownerNeeds, {
      kind: 'transportation',
      items: [],
      destination: 'hospital',
    });
    assert.equal(saved.json().ownerNeedsSkill, 'tr');
    const holder = (
      await mint(post, { label: 'Driver', network: true, skills: ['tr'] })
    ).revealed;
    noteUltraPosition({
      key: VAN_KEY,
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: Date.now(),
    });
    const sent = await post('/release', { incident: 'fire' });
    assert.equal(sent.status, 200, sent.text);
    const running = sent.json().releases[0];
    assert.deepEqual(running.needs, saved.json().ownerNeeds);
    const answer = (await net(holder.token)).json();
    assert.deepEqual(answer.needs, saved.json().ownerNeeds);
    // The token the owner gave out in advance says this holder can drive.
    const token = sent.json().tokens.find((item) => item.label === 'Driver');
    assert.ok(token.skills.some((item) => item.code === 'tr'));
    // Clearing the default changes nothing for the call already running.
    await post('/needs', { needs: null });
    assert.deepEqual(
      (await net(holder.token)).json().needs,
      saved.json().ownerNeeds,
    );
  } finally {
    clock.restore();
  }
});

test('HELP DELIVERY: null clears, an absent or non-object needs is refused, and a hostile helpers file loads clean', async () => {
  const { post, request, file, restart } = setup();
  assert.equal((await request('/status')).json().ownerNeeds, null);
  const cleared = await post('/needs', { needs: null });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(cleared.json().ownerNeeds, null);
  for (const body of [{}, { needs: 'items' }, { needs: 7 }, { needs: [] }]) {
    const refused = await post('/needs', body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.json().error, 'Choose the help to be delivered.');
  }
  assert.equal((await request('/status')).json().ownerNeeds, null);
  // A helpers file whose needs are a JSON object where a string belongs
  // (toString: null would make String() throw) reads as a clean store: the
  // status answers, the needs are gone, and the next save writes them so.
  fs.writeFileSync(
    file('ultra-help.json'),
    JSON.stringify({
      version: 1,
      contacts: [],
      owner: {
        number: '+15065550123',
        needs: { kind: 'items', items: [{ toString: null }] },
      },
    }),
  );
  const fresh = restart();
  const status = await fresh.request('/status');
  assert.equal(status.status, 200, status.text);
  assert.equal(status.json().ownerNeeds, null);
  assert.equal(status.json().ownerNumber, '+15065550123');
  assert.equal(status.json().helpStore, 'ok');
  const saved = await fresh.post('/needs', {
    needs: { kind: 'items', items: ['Insulin'] },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json().ownerNeeds, {
    kind: 'items',
    items: ['Insulin'],
    destination: '',
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file('ultra-help.json'), 'utf8')).owner.needs,
    { kind: 'items', items: ['Insulin'], destination: '' },
  );
});

test('every catalog skill mints and reveals, Mr./Mrs. Nice Guy among them', async () => {
  const { post, file } = setup();
  assert.equal(ULTRA_SKILL_SETS.length, 15);
  const codes = ULTRA_SKILL_SETS.map((item) => item.code);
  assert.ok(codes.includes('ng'));
  const nice = await mint(post, {
    label: 'Neighbour',
    network: true,
    skills: ['ng'],
  });
  assert.equal(nice.revealed.token.slice(48), '.s.ng');
  assert.deepEqual(
    nice.revealed.skills.map((item) => item.label),
    ['Mr./Mrs. Nice Guy'],
  );
  const row = nice.tokens.find((item) => item.id === nice.revealed.id);
  assert.deepEqual(row.skills, [{ code: 'ng', label: 'Mr./Mrs. Nice Guy' }]);
  const all = await mint(post, {
    label: 'Everything',
    network: true,
    skills: codes,
    custom: ['Coast Guard', 'Swift Water', 'Drone Pilot', 'Nurse', 'Welder'],
    encrypt: true,
  });
  assert.equal(all.revealed.skills.length, 20);
  assert.ok(ULTRA_TOKEN_PATTERN.test(all.revealed.token));
  assert.ok(
    all.revealed.skills.some((item) => item.label === 'Mr./Mrs. Nice Guy'),
  );
  const shown = await post('/tokens', { reveal: true, id: all.revealed.id });
  assert.equal(shown.status, 200, shown.text);
  assert.equal(shown.json().revealed.token, all.revealed.token);
  assert.ok(
    shown
      .json()
      .revealed.skills.some((item) => item.label === 'Mr./Mrs. Nice Guy'),
  );
  assert.ok(
    !fs.readFileSync(file('ultra-tokens.json'), 'utf8').includes('Nice'),
  );
});

test('a token string that cannot be built is a generic failure with its own code, never weak random', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-uht-'));
  fs.mkdirSync(path.join(root, 'config'));
  writeFeeds(root, [VAN]);
  let composed = 0;
  const plugin = ultraHelpProxy({
    sourceRoot: root,
    harden: () => true,
    compose: () => {
      composed += 1;
      return null;
    },
  });
  const request = harness(plugin);
  const post = (url, body) =>
    request(url, { method: 'POST', headers: PAGE, body });
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  try {
    const answer = await post('/tokens', { label: 'Neighbour' });
    assert.equal(answer.status, 500);
    assert.deepEqual(answer.json(), { error: 'Ultra help failed' });
    assert.equal(composed, 1, 'no redraw: a compose failure is not a repeat');
    assert.equal(warned.length, 1);
    assert.match(warned[0], /GEV_TOKEN_COMPOSE/);
    assert.doesNotMatch(warned[0], /GEV_WEAK_RANDOM|uht1\./);
    assert.ok(!fs.existsSync(path.join(root, 'config', 'ultra-tokens.json')));
  } finally {
    console.warn = warn;
    ultraHelpProxy({
      sourceRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'gev-uht-')),
    });
  }
});

test('a key file another process made first is read back, never written over', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-uht-'));
  fs.mkdirSync(path.join(root, 'config'));
  writeFeeds(root, [VAN]);
  const keyFile = path.join(root, 'config', 'ultra-tokens.key');
  const winner = otherKeyText(40);
  // The hardener runs on the staged temp before the exclusive install; a
  // key file appearing meanwhile is what a second mint racing this one does.
  const plugin = ultraHelpProxy({
    sourceRoot: root,
    harden: (file) => {
      if (/ultra-tokens\.key\./.test(path.basename(file)))
        fs.writeFileSync(keyFile, winner);
      return true;
    },
  });
  const request = harness(plugin);
  const post = (url, body) =>
    request(url, { method: 'POST', headers: PAGE, body });
  try {
    const minted = await mint(post);
    assert.equal(fs.readFileSync(keyFile, 'utf8'), winner);
    const key = parseUltraTokenKey(winner);
    const record = JSON.parse(
      fs.readFileSync(path.join(root, 'config', 'ultra-tokens.json'), 'utf8'),
    );
    assert.equal(record.keyId, ultraTokenKeyId(key));
    assert.equal(
      openUltraToken(record.tokens[0].sealed, key, { id: record.tokens[0].id }),
      minted.revealed.token,
    );
    assert.deepEqual(
      fs
        .readdirSync(path.join(root, 'config'))
        .filter((name) => /\.tmp$/.test(name)),
      [],
      'no staged temp is left beside the key',
    );
  } finally {
    ultraHelpProxy({
      sourceRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'gev-uht-')),
    });
  }
});

test('a fix from the phone link is handed to the device layer, so its pin and path follow the trip', async () => {
  setup();
  const clock = withClock(Date.UTC(2026, 9, 4, 18));
  const taken = [];
  onUltraPhoneFix((fix) => taken.push(fix));
  try {
    const answer = await phone(`/ultra/${VAN_KEY}/help`, {
      method: 'POST',
      headers: JSON_BODY,
      body: { lat: 45.3, lon: -66.1, incident: 'fire' },
    });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(taken.length, 1);
    assert.deepEqual(
      [taken[0].feedId, taken[0].lat, taken[0].lon],
      ['security-van', 45.3, -66.1],
    );
    assert.equal(taken[0].at, Date.now());
  } finally {
    onUltraPhoneFix(null);
    clock.restore();
  }
});
