import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  GROK_BOT_APP_LINK,
  GROK_BOT_OPEN_INTERVAL_MS,
  grokBotDesktopProxy,
  grokBotLaunchTarget,
  systemOpener,
} from '../server/providers/grokBotDesktop.js';

const B = String.fromCharCode(92);
const win = (...parts) => parts.join(B);
const SHORTCUT = win(
  'C:',
  'Users',
  'jeffs',
  'OneDrive',
  'Desktop',
  'Grok Bot.lnk',
);
const EXPLORER = win('C:', 'Windows', 'explorer.exe');

/** A file system holding only these paths: files, and folders ending in '/'. */
function filesystem(paths) {
  return {
    statSync(target) {
      if (paths.includes(target))
        return { isFile: () => true, isDirectory: () => false };
      if (paths.includes(`${target}/`))
        return { isFile: () => false, isDirectory: () => true };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  };
}

function withEnv(t, values) {
  const before = {};
  for (const [name, value] of Object.entries(values)) {
    before[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const LOCAL = {
  host: 'localhost:4173',
  origin: 'http://localhost:4173',
  'content-type': 'application/json',
};

function setup({ paths = [SHORTCUT, EXPLORER], platform = 'win32' } = {}) {
  const spawned = [];
  let clock = 1_000_000;
  const plugin = grokBotDesktopProxy({
    platform,
    fileSystem: filesystem(paths),
    now: () => clock,
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { on() {}, unref() {} };
    },
  });
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use: (route, fn) => route === '/api/social/grok-bot' && (handler = fn),
    },
  });
  const call = ({
    url = '/open',
    method = 'POST',
    headers = LOCAL,
    remoteAddress = '127.0.0.1',
    body = '{}',
  } = {}) =>
    new Promise((resolve) => {
      const req = Readable.from(body ? [Buffer.from(body)] : []);
      Object.assign(req, { url, method, headers, socket: { remoteAddress } });
      const res = {
        writeHead(status, values) {
          this.status = status;
          this.headers = values;
        },
        end(payload = '') {
          resolve({
            status: this.status,
            headers: this.headers,
            json: () => JSON.parse(String(payload)),
          });
        },
      };
      handler(req, res);
    });
  return { call, spawned, tick: (ms) => (clock += ms) };
}

test('what is opened: the GROK_BOT_LINK shortcut on a local drive, else Grok Bot’s own link; never a share', () => {
  // Every path below exists, so only the rule itself can refuse one.
  const SHARE = `${B}${B}server${B}share${B}Grok Bot.lnk`;
  const DEVICE = `${B}${B}?${B}C:${B}Grok Bot.lnk`;
  const fileSystem = filesystem([
    SHORTCUT,
    win('D:', 'Apps', 'Grok Bot', 'Grok Bot.exe'),
    SHARE,
    DEVICE,
    win('Grok Bot', 'Grok Bot.lnk'),
    win('C:', 'Users', 'jeffs', 'Desktop', 'notes.txt'),
    win('C:', 'Users', 'jeffs', 'Desktop', 'run.bat'),
    'grokbot://app/v1/agent?id=x',
  ]);
  const target = (value, platform = 'win32') =>
    grokBotLaunchTarget({ GROK_BOT_LINK: value }, { platform, fileSystem });
  assert.deepEqual(target(SHORTCUT), { target: SHORTCUT, kind: 'shortcut' });
  assert.equal(
    target(`  ${SHORTCUT}  `).kind,
    'shortcut',
    'surrounding spaces are trimmed',
  );
  assert.equal(
    target(win('D:', 'Apps', 'Grok Bot', 'Grok Bot.exe')).kind,
    'shortcut',
  );
  assert.deepEqual(grokBotLaunchTarget({}, { platform: 'win32', fileSystem }), {
    target: GROK_BOT_APP_LINK,
    kind: 'app-link',
  });
  assert.equal(GROK_BOT_APP_LINK, 'grokbot://app/v1/open');
  for (const refused of [
    SHARE,
    DEVICE,
    win('Grok Bot', 'Grok Bot.lnk'),
    win('C:', 'Users', 'jeffs', 'Desktop', 'notes.txt'),
    win('C:', 'Users', 'jeffs', 'Desktop', 'run.bat'),
    win('C:', 'Missing', 'Grok Bot.lnk'),
    `${SHORTCUT}"`,
    win('C:', 'Users', 'jeffs\u0007', 'Desktop', 'Grok Bot.lnk'),
    'grokbot://app/v1/agent?id=x',
    'https://example.com/Grok Bot.exe',
  ]) {
    assert.equal(target(refused).kind, 'refused', JSON.stringify(refused));
  }
  // Elsewhere: an absolute path that exists; a macOS app is a folder.
  const mac = filesystem(['/Applications/Grok Bot.app/']);
  assert.equal(
    grokBotLaunchTarget(
      { GROK_BOT_LINK: '/Applications/Grok Bot.app' },
      { platform: 'darwin', fileSystem: mac },
    ).kind,
    'shortcut',
  );
  assert.equal(
    grokBotLaunchTarget(
      { GROK_BOT_LINK: 'Grok Bot.app' },
      { platform: 'darwin', fileSystem: mac },
    ).kind,
    'refused',
  );
});

test('the opener is the system’s own, by its full path, never found on PATH', () => {
  const fileSystem = filesystem([
    EXPLORER,
    '/usr/bin/open',
    '/usr/bin/xdg-open',
  ]);
  assert.equal(
    systemOpener(
      { SystemRoot: win('C:', 'Windows') },
      { platform: 'win32', fileSystem },
    ),
    EXPLORER,
  );
  assert.equal(
    systemOpener(
      { SYSTEMROOT: `${win('C:', 'Windows')}${B}` },
      { platform: 'win32', fileSystem },
    ),
    EXPLORER,
  );
  for (const root of [
    win('C:', 'Temp'),
    win('C:', 'Windows', 'System32'),
    `${B}${B}server${B}Windows`,
    '',
  ]) {
    assert.equal(
      systemOpener(
        { SystemRoot: root, PATH: win('C:', 'evil') },
        { platform: 'win32', fileSystem },
      ),
      '',
      root,
    );
  }
  assert.equal(
    systemOpener({}, { platform: 'darwin', fileSystem }),
    '/usr/bin/open',
  );
  assert.equal(
    systemOpener({}, { platform: 'linux', fileSystem }),
    '/usr/bin/xdg-open',
  );
  assert.equal(
    systemOpener({}, { platform: 'linux', fileSystem: filesystem([]) }),
    '',
  );
});

test('open: this machine’s own page only, POST and JSON, and nothing is launched for anyone else', async (t) => {
  withEnv(t, {
    GROK_BOT_LINK: SHORTCUT,
    SystemRoot: win('C:', 'Windows'),
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const page = setup();
  for (const [what, options, status] of [
    ['a GET', { method: 'GET', body: '' }, 405],
    ['a LAN socket', { remoteAddress: '192.168.1.50' }, 403],
    [
      'a foreign host',
      {
        headers: {
          ...LOCAL,
          host: 'rebind.evil:4173',
          origin: 'http://rebind.evil:4173',
        },
      },
      403,
    ],
    [
      'another origin',
      { headers: { ...LOCAL, origin: 'https://evil.example' } },
      403,
    ],
    [
      'no origin',
      {
        headers: { host: 'localhost:4173', 'content-type': 'application/json' },
      },
      403,
    ],
    [
      'a form post',
      { headers: { ...LOCAL, 'content-type': 'text/plain' } },
      415,
    ],
    [
      'a proxied request',
      { headers: { ...LOCAL, 'x-forwarded-for': '203.0.113.9' } },
      403,
    ],
    ['another path', { url: '/run' }, 404],
  ]) {
    assert.equal((await page.call(options)).status, status, what);
  }
  assert.deepEqual(page.spawned, [], 'nothing was opened');
});

test('open: the configured shortcut through Explorer, once every few seconds, and never a target from the request', async (t) => {
  withEnv(t, {
    GROK_BOT_LINK: SHORTCUT,
    SystemRoot: win('C:', 'Windows'),
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const page = setup();
  const opened = await page.call({
    body: JSON.stringify({
      target: win('C:', 'Windows', 'System32', 'cmd.exe'),
      GROK_BOT_LINK: 'x',
    }),
  });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json(), { ok: true, opened: 'shortcut' });
  assert.equal(opened.headers['Cache-Control'], 'no-store');
  assert.deepEqual(page.spawned, [
    {
      command: EXPLORER,
      args: [SHORTCUT],
      options: { detached: true, stdio: 'ignore', windowsHide: true },
    },
  ]);
  // A held key or a looping page cannot stack windows.
  assert.equal((await page.call()).status, 429);
  page.tick(GROK_BOT_OPEN_INTERVAL_MS);
  assert.equal((await page.call()).status, 200);
  assert.equal(page.spawned.length, 2);
  // No GROK_BOT_LINK: Grok Bot's own link.
  process.env.GROK_BOT_LINK = '';
  page.tick(GROK_BOT_OPEN_INTERVAL_MS);
  const link = await page.call();
  assert.deepEqual(link.json(), { ok: true, opened: 'app-link' });
  assert.deepEqual(page.spawned.at(-1).args, [GROK_BOT_APP_LINK]);
});

test('open: a GROK_BOT_LINK that is not a Grok Bot shortcut here, or no opener, launches nothing', async (t) => {
  withEnv(t, {
    GROK_BOT_LINK: `${B}${B}server${B}share${B}Grok Bot.lnk`,
    SystemRoot: win('C:', 'Windows'),
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const page = setup();
  const refused = await page.call();
  assert.equal(refused.status, 409);
  assert.match(
    refused.json().error,
    /GROK_BOT_LINK in \.env is not a Grok Bot shortcut on this computer/,
  );
  process.env.GROK_BOT_LINK = SHORTCUT;
  process.env.SystemRoot = win('C:', 'Temp');
  const noOpener = await page.call();
  assert.equal(noOpener.status, 503);
  assert.deepEqual(page.spawned, []);
});
