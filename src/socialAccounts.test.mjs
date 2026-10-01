import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { socialAccountsProxy } from '../server/providers/socialAccounts.js';
import {
  SOCIAL_ACCOUNT_KDF,
  SOCIAL_LOGIN_LOCKED,
  listSocialLogins,
  openSocialLogin,
  removeSocialLogin,
  saveSocialLogin,
} from './socialAccounts.mjs';

const USER_ID = 'river.operator.handle';
const SECRET = 's3al-check-value-not-a-platform-login';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gev-social-accounts-'));
}

function storePath(root) {
  return path.join(root, 'config', 'social-accounts.json');
}

function keyPath(root) {
  return path.join(root, 'config', 'social-accounts.key');
}

function diskText(root) {
  return fs.readFileSync(storePath(root), 'utf8');
}

function macKey(root) {
  const master = Buffer.from(fs.readFileSync(keyPath(root), 'utf8').trim(), 'hex');
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      master,
      Buffer.from(SOCIAL_ACCOUNT_KDF.salt),
      Buffer.from(SOCIAL_ACCOUNT_KDF.mac),
      32,
    ),
  );
}

function macFor(key, platform, sealed) {
  return crypto
    .createHmac('sha256', key)
    .update(platform)
    .update('\n')
    .update(sealed.iv)
    .update('\n')
    .update(sealed.data)
    .update('\n')
    .update(sealed.tag)
    .digest('hex');
}

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return routes;
}

function request(
  handler,
  {
    method = 'GET',
    body = '',
    headers: requestHeaders = {
      host: 'localhost:4173',
      origin: 'http://localhost:4173',
      'content-type': 'application/json',
    },
    remoteAddress = '127.0.0.1',
  } = {},
) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method,
      url: '/',
      headers: requestHeaders,
      socket: { remoteAddress },
    });
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(status, values) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(values || {})) this.setHeader(name, value);
      },
      end(payload = '') {
        resolve({
          status: this.statusCode,
          headers,
          body: String(payload),
          json: () => JSON.parse(String(payload)),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('a login is sealed at rest and the password is not in the file or the list', (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = saveSocialLogin(root, { platform: 'x', userId: USER_ID, password: SECRET });
  assert.equal(saved.ok, true);
  assert.equal(saved.userId, USER_ID);
  assert.equal(Object.hasOwn(saved, 'password'), false);
  const disk = diskText(root);
  assert.equal(disk.includes(SECRET), false);
  assert.equal(disk.includes(USER_ID), false);
  assert.equal(fs.readFileSync(keyPath(root), 'utf8').includes(SECRET), false);
  const listed = listSocialLogins(root);
  assert.equal(listed.locked, false);
  assert.deepEqual(listed.accounts, [{ platform: 'x', userId: USER_ID, passwordSaved: true }]);
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
  const opened = openSocialLogin(root, 'x');
  assert.equal(opened.userId, USER_ID);
  assert.equal(opened.password === SECRET, true);
  assert.equal(openSocialLogin(root, 'tiktok'), null);
});

test('a swapped or retagged row does not open, and a broken canary is not rewritten', (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(saveSocialLogin(root, { platform: 'x', userId: USER_ID, password: SECRET }).ok, true);
  assert.equal(
    saveSocialLogin(root, { platform: 'tiktok', userId: 'city.desk', password: 'other-seal-value' }).ok,
    true,
  );
  const file = JSON.parse(diskText(root));
  file.accounts.facebook = { ...file.accounts.x };
  fs.writeFileSync(storePath(root), `${JSON.stringify(file, null, 2)}\n`);
  const swapped = listSocialLogins(root);
  assert.equal(swapped.accounts.some((row) => row.platform === 'facebook'), false);
  assert.equal(swapped.accounts.some((row) => row.platform === 'x'), true);
  assert.equal(openSocialLogin(root, 'facebook'), null);

  const retag = JSON.parse(diskText(root));
  retag.accounts.facebook.mac = macFor(macKey(root), 'facebook', retag.accounts.x);
  fs.writeFileSync(storePath(root), `${JSON.stringify(retag, null, 2)}\n`);
  assert.equal(listSocialLogins(root).accounts.some((row) => row.platform === 'facebook'), false);
  assert.equal(openSocialLogin(root, 'x').userId, USER_ID);

  const tampered = JSON.parse(diskText(root));
  const data = tampered.accounts.x.data;
  tampered.accounts.x.data = `${data.slice(0, -1)}${data.endsWith('A') ? 'B' : 'A'}`;
  fs.writeFileSync(storePath(root), `${JSON.stringify(tampered, null, 2)}\n`);
  assert.equal(listSocialLogins(root).accounts.some((row) => row.platform === 'x'), false);
  assert.equal(openSocialLogin(root, 'x'), null);
  assert.equal(JSON.stringify(listSocialLogins(root)).includes(SECRET), false);

  const broken = JSON.parse(diskText(root));
  const canary = broken.canary.data;
  broken.canary.data = `${canary.slice(0, -1)}${canary.endsWith('A') ? 'B' : 'A'}`;
  const brokenText = `${JSON.stringify(broken, null, 2)}\n`;
  fs.writeFileSync(storePath(root), brokenText);
  const locked = listSocialLogins(root);
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.accounts, []);
  const refused = saveSocialLogin(root, { platform: 'x', userId: USER_ID, password: SECRET });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, SOCIAL_LOGIN_LOCKED);
  assert.equal(fs.readFileSync(storePath(root), 'utf8'), brokenText);
  assert.equal(removeSocialLogin(root, 'x').ok, false);
  assert.equal(fs.readFileSync(storePath(root), 'utf8'), brokenText);
});

test('the accounts route never returns the password', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handler = install(socialAccountsProxy({ sourceRoot: root })).get('/api/social/accounts');
  const created = await request(handler, {
    method: 'POST',
    body: JSON.stringify({ platform: 'x', userId: USER_ID, password: SECRET }),
  });
  assert.equal(created.status, 200);
  assert.equal(created.headers['cache-control'], 'no-store, private');
  assert.equal(created.body.includes(SECRET), false);
  assert.equal(created.json().userId, USER_ID);
  assert.equal(Object.hasOwn(created.json(), 'password'), false);
  const listed = await request(handler);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.includes(SECRET), false);
  assert.equal(listed.json().accounts[0].passwordSaved, true);
  assert.equal(Object.hasOwn(listed.json().accounts[0], 'password'), false);
  const leaked = await request(handler, {
    method: 'POST',
    body: `{"platform":"x","userId":"${USER_ID}","password":"${SECRET}"`,
  });
  assert.equal(leaked.status, 400);
  assert.equal(leaked.body.includes(SECRET), false);
  assert.equal((await request(handler, { method: 'PUT', body: '{}' })).status, 405);
  const removed = await request(handler, {
    method: 'DELETE',
    body: JSON.stringify({ platform: 'x' }),
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.includes(SECRET), false);
  assert.deepEqual((await request(handler)).json().accounts, []);
  assert.equal(
    (await request(handler, { method: 'POST', body: JSON.stringify({ platform: 'snap-map', userId: USER_ID, password: SECRET }) })).json().error,
    'Pick a platform.',
  );
});

test('the accounts route takes a save only from this machine and this page', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handler = install(socialAccountsProxy({ sourceRoot: root })).get('/api/social/accounts');
  const body = JSON.stringify({ platform: 'x', userId: USER_ID, password: SECRET });
  const local = { host: 'localhost:4173', origin: 'http://localhost:4173', 'content-type': 'application/json' };
  // A plain form post from another page needs no preflight: refused before the body.
  const form = await request(handler, { method: 'POST', body, headers: { ...local, 'content-type': 'text/plain' } });
  assert.equal(form.status, 415);
  for (const [what, headers, remoteAddress] of [
    ['another origin', { ...local, origin: 'https://evil.example' }, '127.0.0.1'],
    ['no origin on a save', { host: 'localhost:4173', 'content-type': 'application/json' }, '127.0.0.1'],
    ['a LAN socket', local, '192.168.1.50'],
    ['a foreign host', { ...local, host: 'evil.example', origin: 'http://evil.example' }, '127.0.0.1'],
  ]) {
    const refused = await request(handler, { method: 'POST', body, headers, remoteAddress });
    assert.equal(refused.status, 403, what);
  }
  assert.equal(fs.existsSync(storePath(root)), false, 'nothing was saved');
  // The box's own save still works. The bot swarms keep no login at all
  // (they run on their own keys in POWER UP): grok and openai are refused.
  assert.equal((await request(handler, { method: 'POST', body })).status, 200);
  for (const platform of ['grok', 'openai']) {
    const swarm = await request(handler, {
      method: 'POST',
      body: JSON.stringify({ platform, userId: 'river@example.com', password: SECRET }),
    });
    assert.equal(swarm.status, 400, platform);
    assert.equal(swarm.body.includes(SECRET), false);
  }
  assert.deepEqual(
    (await request(handler)).json().accounts.map((row) => row.platform),
    ['x'],
  );
});
