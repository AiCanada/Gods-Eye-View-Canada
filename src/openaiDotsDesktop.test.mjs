import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  OPENAI_DOTS_APP_LINK,
  OPENAI_DOTS_OPEN_INTERVAL_MS,
  OPENAI_DOTS_PASTE_MAX,
  OPENAI_DOTS_PASTE_SCRIPT,
  OPENAI_DOTS_PASTE_SETTLE_MS,
  OPENAI_DOTS_PASTE_TIMEOUT_MS,
  openaiDotsDesktopProxy,
  openaiDotsLaunchTarget,
  openaiDotsPasteText,
  pasteIntoChatGpt,
  systemOpener,
  systemPowershell,
} from '../server/providers/openaiDotsDesktop.js';
import {
  OWNER_DEVICE_AUTHORITY_HEADER,
  OWNER_DEVICE_HEADER,
  setOwnerDeviceToken,
} from './keySetupCore.mjs';

const B = String.fromCharCode(92);
const win = (...parts) => parts.join(B);
const SHORTCUT = win(
  'C:',
  'Users',
  'jeffs',
  'OneDrive',
  'Desktop',
  'ChatGPT.lnk',
);
const EXPLORER = win('C:', 'Windows', 'explorer.exe');
const POWERSHELL = win(
  'C:',
  'Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const REPO = win('C:', 'repo');
const PASTE_SCRIPT = win('C:', 'repo', 'scripts', 'paste-openai-dots.ps1');

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

function setup({
  paths = [SHORTCUT, EXPLORER],
  platform = 'win32',
  pasteImpl,
} = {}) {
  const spawned = [];
  const pasted = [];
  let clock = 1_000_000;
  const plugin = openaiDotsDesktopProxy({
    platform,
    fileSystem: filesystem(paths),
    now: () => clock,
    sleepImpl: async () => {},
    sourceRoot: REPO,
    pasteImpl:
      pasteImpl === undefined
        ? undefined
        : async (text) => {
            pasted.push(text);
            return pasteImpl(text);
          },
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { stdin: { write() {}, end() {} }, on() {}, unref() {} };
    },
  });
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use: (route, fn) => route === '/api/social/openai-dots' && (handler = fn),
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
  return { call, spawned, pasted, tick: (ms) => (clock += ms) };
}

test('what is opened: the OPENAI_DOTS_LINK shortcut on a local drive, else ChatGPT’s own link; never a share', () => {
  // Every path below exists, so only the rule itself can refuse one.
  const SHARE = `${B}${B}server${B}share${B}ChatGPT.lnk`;
  const DEVICE = `${B}${B}?${B}C:${B}ChatGPT.lnk`;
  const fileSystem = filesystem([
    SHORTCUT,
    win('D:', 'Apps', 'ChatGPT', 'ChatGPT.exe'),
    SHARE,
    DEVICE,
    win('ChatGPT', 'ChatGPT.lnk'),
    win('C:', 'Users', 'jeffs', 'Desktop', 'notes.txt'),
    win('C:', 'Users', 'jeffs', 'Desktop', 'run.bat'),
    'chatgpt://chat',
  ]);
  const target = (value, platform = 'win32') =>
    openaiDotsLaunchTarget(
      { OPENAI_DOTS_LINK: value },
      { platform, fileSystem },
    );
  assert.deepEqual(target(SHORTCUT), { target: SHORTCUT, kind: 'shortcut' });
  assert.equal(
    target(`  ${SHORTCUT}  `).kind,
    'shortcut',
    'surrounding spaces are trimmed',
  );
  assert.equal(
    target(win('D:', 'Apps', 'ChatGPT', 'ChatGPT.exe')).kind,
    'shortcut',
  );
  assert.deepEqual(
    openaiDotsLaunchTarget({}, { platform: 'win32', fileSystem }),
    {
      target: OPENAI_DOTS_APP_LINK,
      kind: 'app-link',
    },
  );
  assert.equal(OPENAI_DOTS_APP_LINK, 'chatgpt://');
  for (const refused of [
    SHARE,
    DEVICE,
    win('ChatGPT', 'ChatGPT.lnk'),
    win('C:', 'Users', 'jeffs', 'Desktop', 'notes.txt'),
    win('C:', 'Users', 'jeffs', 'Desktop', 'run.bat'),
    win('C:', 'Missing', 'ChatGPT.lnk'),
    `${SHORTCUT}"`,
    win('C:', 'Users', 'jeffs\u0007', 'Desktop', 'ChatGPT.lnk'),
    'chatgpt://chat',
    'https://example.com/ChatGPT.exe',
  ]) {
    assert.equal(target(refused).kind, 'refused', JSON.stringify(refused));
  }
  // Elsewhere: an absolute path that exists; a macOS app is a folder.
  const mac = filesystem(['/Applications/ChatGPT.app/']);
  assert.equal(
    openaiDotsLaunchTarget(
      { OPENAI_DOTS_LINK: '/Applications/ChatGPT.app' },
      { platform: 'darwin', fileSystem: mac },
    ).kind,
    'shortcut',
  );
  assert.equal(
    openaiDotsLaunchTarget(
      { OPENAI_DOTS_LINK: 'ChatGPT.app' },
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

test('open: this machine’s own page or the owner phone only, POST and JSON, and nothing is launched for anyone else', async (t) => {
  withEnv(t, {
    OPENAI_DOTS_LINK: SHORTCUT,
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

test('open: the owner phone, stamped by the tailnet mirror, opens ChatGPT on the PC', async (t) => {
  withEnv(t, {
    OPENAI_DOTS_LINK: SHORTCUT,
    SystemRoot: win('C:', 'Windows'),
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const OWNER_TOKEN = '9'.repeat(64);
  const MIRROR = 'http://100.64.0.1:4173';
  setOwnerDeviceToken(OWNER_TOKEN);
  t.after(() => setOwnerDeviceToken(''));
  // Placeholder tailnet addresses: the mirror's Host, Origin and stamp.
  const phone = {
    host: '100.64.0.1:4173',
    origin: MIRROR,
    'content-type': 'application/json',
    [OWNER_DEVICE_HEADER]: OWNER_TOKEN,
    [OWNER_DEVICE_AUTHORITY_HEADER]: MIRROR,
  };
  const page = setup();
  const { [OWNER_DEVICE_HEADER]: _token, ...unstamped } = phone;
  const stranger = await page.call({
    headers: unstamped,
    remoteAddress: '100.64.0.10',
  });
  assert.equal(stranger.status, 403);
  assert.deepEqual(page.spawned, [], 'nothing was opened for a stranger');
  const opened = await page.call({
    headers: phone,
    remoteAddress: '100.64.0.10',
  });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json(), { ok: true, opened: 'shortcut' });
  assert.deepEqual(page.spawned, [
    {
      command: EXPLORER,
      args: [SHORTCUT],
      options: { detached: true, stdio: 'ignore', windowsHide: true },
    },
  ]);
});

test('open: the configured shortcut through Explorer, once every few seconds, and never a target from the request', async (t) => {
  withEnv(t, {
    OPENAI_DOTS_LINK: SHORTCUT,
    SystemRoot: win('C:', 'Windows'),
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const page = setup();
  const opened = await page.call({
    body: JSON.stringify({
      target: win('C:', 'Windows', 'System32', 'cmd.exe'),
      OPENAI_DOTS_LINK: 'x',
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
  page.tick(OPENAI_DOTS_OPEN_INTERVAL_MS);
  assert.equal((await page.call()).status, 200);
  assert.equal(page.spawned.length, 2);
  // No OPENAI_DOTS_LINK: ChatGPT's own link.
  process.env.OPENAI_DOTS_LINK = '';
  page.tick(OPENAI_DOTS_OPEN_INTERVAL_MS);
  const link = await page.call();
  assert.deepEqual(link.json(), { ok: true, opened: 'app-link' });
  assert.deepEqual(page.spawned.at(-1).args, [OPENAI_DOTS_APP_LINK]);
});

test('open: a OPENAI_DOTS_LINK that is not a ChatGPT shortcut here, or no opener, launches nothing', async (t) => {
  withEnv(t, {
    OPENAI_DOTS_LINK: `${B}${B}server${B}share${B}ChatGPT.lnk`,
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
    /OPENAI_DOTS_LINK in \.env is not a ChatGPT shortcut on this computer/,
  );
  process.env.OPENAI_DOTS_LINK = SHORTCUT;
  process.env.SystemRoot = win('C:', 'Temp');
  const noOpener = await page.call();
  assert.equal(noOpener.status, 503);
  assert.deepEqual(page.spawned, []);
});

test('paste text: only paste===true and a bounded string; never a named target', () => {
  assert.equal(
    openaiDotsPasteText({ paste: true, text: 'ChatGPT: go' }),
    'ChatGPT: go',
  );
  assert.equal(openaiDotsPasteText({}), '');
  assert.equal(openaiDotsPasteText({ paste: true }), '');
  assert.equal(openaiDotsPasteText({ paste: 'true', text: 'x' }), '');
  assert.equal(openaiDotsPasteText({ paste: true, text: '' }), '');
  assert.equal(openaiDotsPasteText({ paste: true, text: 1 }), '');
  assert.equal(
    openaiDotsPasteText({
      paste: true,
      text: 'a'.repeat(OPENAI_DOTS_PASTE_MAX + 1),
    }),
    '',
  );
  assert.equal(
    openaiDotsPasteText({
      paste: true,
      text: 'task',
      target: win('C:', 'Windows', 'System32', 'cmd.exe'),
      window: 'Notepad',
      agent: 'other-bot',
    }),
    'task',
  );
  assert.equal(OPENAI_DOTS_PASTE_SCRIPT, 'scripts/paste-openai-dots.ps1');
  assert.ok(
    OPENAI_DOTS_PASTE_SETTLE_MS >= 2000,
    'Ctrl+V waits for the composer after open',
  );
  assert.ok(
    OPENAI_DOTS_PASTE_TIMEOUT_MS >= OPENAI_DOTS_PASTE_SETTLE_MS + 8000,
    'the paste script has time to hunt the window and send',
  );
});

test('systemPowershell is Windows PowerShell 5.1 under SystemRoot, never PATH', () => {
  const fileSystem = filesystem([POWERSHELL]);
  assert.equal(
    systemPowershell(
      { SystemRoot: win('C:', 'Windows') },
      { platform: 'win32', fileSystem },
    ),
    POWERSHELL,
  );
  assert.equal(
    systemPowershell(
      { SystemRoot: win('C:', 'Windows') },
      { platform: 'linux', fileSystem },
    ),
    '',
  );
  assert.equal(
    systemPowershell(
      { SystemRoot: win('C:', 'Temp'), PATH: win('C:', 'evil') },
      { platform: 'win32', fileSystem },
    ),
    '',
  );
});

test('open: OPEN CHATGPT posts {} and does not paste; a named target is still ignored', async (t) => {
  withEnv(t, {
    OPENAI_DOTS_LINK: SHORTCUT,
    SystemRoot: win('C:', 'Windows'),
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const page = setup({ pasteImpl: () => true });
  const opened = await page.call({ body: '{}' });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json(), { ok: true, opened: 'shortcut' });
  assert.deepEqual(page.pasted, []);
  assert.equal(page.spawned.length, 1);
  assert.equal(page.spawned[0].command, EXPLORER);
});

test('open: paste:true with the task pastes into ChatGPT and ignores a request-named window', async (t) => {
  withEnv(t, {
    OPENAI_DOTS_LINK: SHORTCUT,
    SystemRoot: win('C:', 'Windows'),
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const page = setup({ pasteImpl: () => true });
  const task = 'ChatGPT: run a OPENAI DOT SWARM sweep of public social media.';
  const opened = await page.call({
    body: JSON.stringify({
      paste: true,
      text: task,
      target: win('C:', 'Windows', 'System32', 'cmd.exe'),
      window: 'Notepad',
    }),
  });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json(), {
    ok: true,
    opened: 'shortcut',
    pasted: true,
  });
  assert.deepEqual(page.pasted, [task]);
  assert.equal(page.spawned.length, 1);
  assert.equal(page.spawned[0].command, EXPLORER);
  assert.deepEqual(page.spawned[0].args, [SHORTCUT]);
});

test('open: paste:true without text, or with a too-long task, never pastes the clipboard', async (t) => {
  withEnv(t, {
    OPENAI_DOTS_LINK: SHORTCUT,
    SystemRoot: win('C:', 'Windows'),
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const page = setup({ pasteImpl: () => true });
  const missing = await page.call({
    body: JSON.stringify({ paste: true }),
  });
  assert.deepEqual(missing.json(), { ok: true, opened: 'shortcut' });
  page.tick(OPENAI_DOTS_OPEN_INTERVAL_MS);
  const empty = await page.call({
    body: JSON.stringify({ paste: true, text: '' }),
  });
  assert.deepEqual(empty.json(), { ok: true, opened: 'shortcut' });
  page.tick(OPENAI_DOTS_OPEN_INTERVAL_MS);
  const huge = await page.call({
    body: JSON.stringify({
      paste: true,
      text: 'a'.repeat(OPENAI_DOTS_PASTE_MAX + 1),
    }),
  });
  assert.deepEqual(huge.json(), { ok: true, opened: 'shortcut' });
  assert.deepEqual(page.pasted, []);
});

test('open: a failed paste still opens ChatGPT and says pasted false', async (t) => {
  withEnv(t, {
    OPENAI_DOTS_LINK: SHORTCUT,
    SystemRoot: win('C:', 'Windows'),
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const page = setup({ pasteImpl: () => false });
  const opened = await page.call({
    body: JSON.stringify({ paste: true, text: 'task' }),
  });
  assert.deepEqual(opened.json(), {
    ok: true,
    opened: 'shortcut',
    pasted: false,
  });
  assert.deepEqual(page.pasted, ['task']);
});

test('open: paste is Windows-only; macOS opens and does not paste', async (t) => {
  withEnv(t, {
    OPENAI_DOTS_LINK: undefined,
    PINOKIO_SHARE_VAR: undefined,
    PINOKIO_SHARE_LOCAL: undefined,
    PINOKIO_SHARE_CLOUDFLARE: undefined,
  });
  const page = setup({
    platform: 'darwin',
    paths: ['/usr/bin/open'],
  });
  const opened = await page.call({
    body: JSON.stringify({ paste: true, text: 'task' }),
  });
  assert.deepEqual(opened.json(), {
    ok: true,
    opened: 'app-link',
    pasted: false,
  });
  assert.equal(page.spawned.length, 1);
  assert.equal(page.spawned[0].command, '/usr/bin/open');
});

test('pasteIntoChatGpt: PowerShell -File the repo script, task on stdin, never argv', async () => {
  const spawned = [];
  const fileSystem = filesystem([POWERSHELL, PASTE_SCRIPT]);
  const ok = await pasteIntoChatGpt('ChatGPT: go', {
    platform: 'win32',
    fileSystem,
    env: { SystemRoot: win('C:', 'Windows') },
    sourceRoot: REPO,
    spawnImpl: (command, args, options) => {
      const rec = { command, args, options, stdin: '' };
      spawned.push(rec);
      return {
        stdin: {
          write(chunk) {
            rec.stdin += String(chunk);
          },
          end() {},
        },
        on(event, fn) {
          if (event === 'exit') queueMicrotask(() => fn(0));
        },
      };
    },
  });
  assert.equal(ok, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, POWERSHELL);
  assert.deepEqual(spawned[0].args, [
    '-NoProfile',
    '-STA',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    `"${PASTE_SCRIPT}"`,
  ]);
  assert.equal(spawned[0].stdin, 'ChatGPT: go');
  assert.equal(spawned[0].args.includes('ChatGPT: go'), false);
  assert.deepEqual(spawned[0].options, {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: false,
    windowsVerbatimArguments: true,
  });
});

test('paste-openai-dots.ps1 keeps ChatGPT topmost and clicks in one DPI space', () => {
  const script = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'paste-openai-dots.ps1',
    ),
    'utf8',
  );
  assert.match(script, /WindowFromPoint/);
  assert.match(script, /SetCursorPos/);
  assert.match(script, /HWND_TOPMOST/);
  assert.match(script, /OpenStandardInput/);
  assert.match(script, /PointBelongsTo/);
  assert.match(script, /Get-ChatGptWindow/);
  assert.match(script, /ChatGPT Classic/);
  assert.match(script, /EnumWindows/);
  assert.equal(/\bMOUSEEVENTF_ABSOLUTE\b/.test(script), false);
  assert.equal(/\bSetProcessDPIAware\b/.test(script), false);
  assert.equal(/(^|[^A-Za-z])\$pid\s*=/im.test(script), false);
});

test('pasteIntoChatGpt refuses an empty task, a missing script, and non-Windows', async () => {
  const spawned = [];
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, options });
    return { stdin: { write() {}, end() {} }, on() {} };
  };
  const fileSystem = filesystem([POWERSHELL, PASTE_SCRIPT]);
  const opts = {
    spawnImpl,
    platform: 'win32',
    fileSystem,
    env: { SystemRoot: win('C:', 'Windows') },
    sourceRoot: REPO,
  };
  assert.equal(await pasteIntoChatGpt('', opts), false);
  assert.equal(
    await pasteIntoChatGpt('task', { ...opts, platform: 'darwin' }),
    false,
  );
  assert.equal(
    await pasteIntoChatGpt('task', {
      ...opts,
      fileSystem: filesystem([POWERSHELL]),
    }),
    false,
  );
  assert.deepEqual(spawned, []);
});
