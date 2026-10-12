import { spawn } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function codexAuthPath({
  environment = process.env,
  home = os.homedir(),
} = {}) {
  const explicit = String(environment.CODEX_AUTH_JSON || '').trim();
  if (explicit) return path.resolve(explicit);
  const codexHome = String(environment.CODEX_HOME || '').trim();
  return path.join(
    codexHome ? path.resolve(codexHome) : path.join(home, '.codex'),
    'auth.json',
  );
}

/** An optional operator lock that refuses the metered API-key voice lane. */
export function preferCodexOAuth(environment = process.env) {
  if (!Object.hasOwn(environment, 'GEV_PREFER_CODEX_OAUTH')) return false;
  const value = String(environment.GEV_PREFER_CODEX_OAUTH || '')
    .trim()
    .toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(
    'GEV_PREFER_CODEX_OAUTH must be true or false. Refusing to choose a voice auth mode.',
  );
}

function codexOAuthError(message, code = 'CODEX_OAUTH_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function readCodexOAuthAccessToken({
  authPath = codexAuthPath(),
  readFile = readFileSync,
  statFile = statSync,
  nowMs = Date.now(),
} = {}) {
  const unavailable =
    'ChatGPT sign-in is unavailable. Sign in to Codex or the ChatGPT desktop app and try again.';
  let parsed;
  try {
    parsed = JSON.parse(readFile(authPath, 'utf8'));
  } catch {
    throw codexOAuthError(unavailable);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw codexOAuthError(unavailable);
  }
  const mode = String(parsed.auth_mode || '')
    .trim()
    .toLowerCase();
  const chatGptMode = mode
    ? mode === 'chatgpt' || mode === 'chatgptauthtokens'
    : typeof parsed.OPENAI_API_KEY !== 'string';
  const token = parsed.tokens?.access_token;
  if (!chatGptMode || typeof token !== 'string' || !token.trim()) {
    throw codexOAuthError(unavailable);
  }

  // This only checks token shape and expiry. OpenAI verifies the signature when
  // minting the short-lived Realtime credential; we never modify auth.json.
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw codexOAuthError(unavailable);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw codexOAuthError(unavailable);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codexOAuthError(unavailable);
  }
  let expiresAtMs;
  if (Object.hasOwn(payload, 'exp')) {
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      throw codexOAuthError(unavailable);
    }
    expiresAtMs = payload.exp * 1000;
  } else {
    try {
      expiresAtMs = statFile(authPath).mtimeMs + 60 * 60 * 1000;
    } catch {
      throw codexOAuthError(unavailable);
    }
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + 60_000) {
    throw codexOAuthError(
      'ChatGPT sign-in has expired. Re-authenticate in Provider Settings or run codex login and try again.',
      'CODEX_OAUTH_REAUTH_REQUIRED',
    );
  }
  return token;
}

export function resolveCodexExecutable({
  environment = process.env,
  home = os.homedir(),
  access = accessSync,
  platform = process.platform,
} = {}) {
  const explicit = String(environment.CODEX_BIN || '').trim();
  if (explicit) return explicit;

  const paths = platform === 'win32' ? path.win32 : path.posix;
  for (const candidate of [
    paths.join(home, '.local', 'bin', 'codex'),
    paths.join(
      home,
      '.codex',
      'packages',
      'standalone',
      'current',
      'bin',
      'codex',
    ),
  ]) {
    try {
      access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Fall through to the next known location, then PATH.
    }
  }
  return 'codex';
}

/**
 * An npm `codex.cmd` shim runs `node <its folder>\node_modules\@openai\codex\bin\codex.js`.
 * Node will not start a .cmd without a shell, so run that script with node
 * directly: the shim folder's own node.exe when it has one, else this node.
 */
function codexShimLaunch(shim, { exists, execPath }) {
  const folder = path.win32.dirname(shim);
  const script = path.win32.join(
    folder,
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  if (!exists(script)) return null;
  const ownNode = path.win32.join(folder, 'node.exe');
  return { command: exists(ownNode) ? ownNode : execPath, args: [script] };
}

/**
 * How to start Codex: `{ command, args }`, with `login` added by the caller.
 * Elsewhere this is `resolveCodexExecutable`. On Windows the answer is always
 * an absolute path, so the child's working folder is never searched before
 * PATH: `CODEX_BIN`, then Codex's own installs, then each absolute PATH folder
 * for codex.exe or an npm codex.cmd shim. Null when none is found.
 */
export function resolveCodexLaunch({
  environment = process.env,
  home = os.homedir(),
  access = accessSync,
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  if (platform !== 'win32') {
    return {
      command: resolveCodexExecutable({ environment, home, access, platform }),
      args: [],
    };
  }
  const exists = (file) => {
    try {
      access(file, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  const fromFile = (file) =>
    /\.(?:cmd|bat)$/i.test(file)
      ? codexShimLaunch(file, { exists, execPath })
      : { command: file, args: [] };

  const explicit = String(environment.CODEX_BIN || '').trim();
  if (explicit) {
    return path.win32.isAbsolute(explicit) && exists(explicit)
      ? fromFile(explicit)
      : null;
  }
  for (const candidate of [
    path.win32.join(
      home,
      '.codex',
      'packages',
      'standalone',
      'current',
      'bin',
      'codex.exe',
    ),
    path.win32.join(home, '.local', 'bin', 'codex.exe'),
  ]) {
    if (exists(candidate)) return { command: candidate, args: [] };
  }
  const pathValue =
    Object.entries(environment).find(
      ([name]) => name.toUpperCase() === 'PATH',
    )?.[1] || '';
  for (const raw of String(pathValue).split(';')) {
    const folder = raw.trim().replace(/^"(.*)"$/, '$1');
    // A relative PATH entry would resolve against the working folder.
    if (!folder || !path.win32.isAbsolute(folder)) continue;
    const exe = path.win32.join(folder, 'codex.exe');
    if (exists(exe)) return { command: exe, args: [] };
    const shim = path.win32.join(folder, 'codex.cmd');
    if (exists(shim)) {
      const launch = codexShimLaunch(shim, { exists, execPath });
      if (launch) return launch;
    }
  }
  return null;
}

// What `codex login` needs to find its home, open a browser and reach OpenAI.
// The server's own environment also holds every provider secret, so the
// child receives only these names.
const CODEX_LOGIN_ENV =
  /^(?:PATH|PATHEXT|HOME|USER|USERNAME|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TZ|TMPDIR|TEMP|TMP|XDG_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|BROWSER|WSL_[A-Z_]+|WSLENV|(?:HTTPS?|ALL|NO)_PROXY|SSL_CERT_(?:FILE|DIR)|NODE_EXTRA_CA_CERTS|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|HOMEDRIVE|HOMEPATH|CODEX_[A-Z_]+)$/i;

/** The environment `codex login` runs with: the allowlist, then `CODEX_HOME`. */
export function codexLoginEnvironment(environment, codexHome) {
  const env = {};
  for (const [name, value] of Object.entries(environment || {}))
    if (CODEX_LOGIN_ENV.test(name) && value !== undefined) env[name] = value;
  env.CODEX_HOME = codexHome;
  return env;
}

export function startCodexChatGptLogin({
  spawnImpl = spawn,
  environment = process.env,
  home = os.homedir(),
  executable,
  launch = executable
    ? { command: executable, args: [] }
    : resolveCodexLaunch({ environment, home }),
} = {}) {
  // Codex owns its credential storage. An explicit read path must agree with
  // the CLI's write path; never silently sign in to another credential store.
  const configuredHome = String(environment.CODEX_HOME || '').trim();
  const loginHome = configuredHome
    ? path.resolve(configuredHome)
    : path.join(home, '.codex');
  if (
    codexAuthPath({ environment, home }) !== path.join(loginHome, 'auth.json')
  ) {
    return Promise.reject(
      codexOAuthError(
        'CODEX_AUTH_JSON does not match the Codex login storage path. Set CODEX_HOME to the matching directory or sign in to Codex separately.',
        'CODEX_OAUTH_STORAGE_MISMATCH',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    let child;
    let spawned = false;
    let finish;
    const completion = new Promise((done) => {
      finish = done;
    });
    const fail = () => {
      reject(
        codexOAuthError(
          'Could not start ChatGPT sign-in. Check that Codex is installed (npm install -g @openai/codex), or set CODEX_BIN to its full path.',
          'CODEX_OAUTH_LOGIN_FAILED',
        ),
      );
      finish({ exitCode: null });
    };
    if (!launch?.command) {
      fail();
      return;
    }
    try {
      child = spawnImpl(launch.command, [...(launch.args || []), 'login'], {
        cwd: home,
        detached: true,
        stdio: 'ignore',
        // Detached on Windows would open a console window of its own.
        windowsHide: true,
        env: codexLoginEnvironment(environment, loginHome),
      });
    } catch {
      fail();
      return;
    }

    child.once('error', () => {
      if (!spawned) fail();
      else finish({ exitCode: null });
    });
    child.once('exit', (exitCode) => finish({ exitCode }));
    child.once('spawn', () => {
      spawned = true;
      child.unref?.();
      resolve({
        completion,
        cancel() {
          try {
            child.kill?.('SIGTERM');
          } catch {
            /* Already stopped. */
          }
        },
      });
    });
  });
}

/** One local login owner shared by the launch and status endpoints. */
export function createCodexOAuthLogin({
  resolveOAuthAccessToken = () => readCodexOAuthAccessToken(),
  startOAuthLogin = () => startCodexChatGptLogin(),
  loginTimeoutMs = 120_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let active = null;
  let failure = null;
  let disposed = false;

  function credentials() {
    try {
      if (resolveOAuthAccessToken()) return { available: true };
    } catch (error) {
      const code = error?.code || 'CODEX_OAUTH_UNAVAILABLE';
      return {
        available: false,
        error: error?.message || 'ChatGPT sign-in is unavailable',
        code,
        reauthRequired: code === 'CODEX_OAUTH_REAUTH_REQUIRED',
      };
    }
    return {
      available: false,
      error: 'ChatGPT sign-in is unavailable',
      code: 'CODEX_OAUTH_UNAVAILABLE',
      reauthRequired: false,
    };
  }

  function status() {
    const current = credentials();
    if (current.available) return current;
    if (failure) return { available: false, ...failure, loginFailed: true };
    return active ? { ...current, pending: true } : current;
  }

  function finish(attempt, error) {
    if (active !== attempt) return;
    clearTimer(attempt.timer);
    active = null;
    failure = error;
  }

  async function start() {
    if (disposed)
      throw codexOAuthError(
        'ChatGPT sign-in is unavailable because the server has stopped.',
        'CODEX_OAUTH_LOGIN_FAILED',
      );
    if (credentials().available)
      return { available: true, started: false, pending: false };
    if (active) return { available: false, started: false, pending: true };

    // Reserve the attempt before awaiting spawn so concurrent POSTs share it.
    const attempt = { process: null, timer: null };
    active = attempt;
    failure = null;
    attempt.timer = setTimer(() => {
      finish(attempt, {
        code: 'CODEX_OAUTH_LOGIN_TIMEOUT',
        error:
          'ChatGPT sign-in timed out. Click USE CHATGPT OAUTH to try again.',
      });
      attempt.process?.cancel();
    }, loginTimeoutMs);
    attempt.timer?.unref?.();

    try {
      const login = await startOAuthLogin();
      if (!login?.completion || typeof login.cancel !== 'function')
        throw new Error('Invalid login process');
      attempt.process = login;
      if (active !== attempt) {
        login.cancel();
        return { ...status(), started: false, pending: false };
      }
      Promise.resolve(login.completion).then(
        (result) => {
          if (active !== attempt) return;
          if (result?.exitCode !== 0) {
            finish(attempt, {
              code: 'CODEX_OAUTH_LOGIN_FAILED',
              error:
                'ChatGPT sign-in did not complete. Try again in Provider Settings, or run codex login separately.',
            });
          } else if (!credentials().available) {
            finish(attempt, {
              code: 'CODEX_OAUTH_STORAGE_UNAVAILABLE',
              error:
                'Codex sign-in finished, but its configured auth.json has no usable ChatGPT token. Check CODEX_HOME and Codex credential storage. GEV can read file storage only.',
            });
          } else finish(attempt, null);
        },
        () =>
          finish(attempt, {
            code: 'CODEX_OAUTH_LOGIN_FAILED',
            error:
              'ChatGPT sign-in did not complete. Try again in Provider Settings.',
          }),
      );
      return { available: false, started: true, pending: true };
    } catch (error) {
      const code =
        error?.code === 'CODEX_OAUTH_STORAGE_MISMATCH'
          ? error.code
          : 'CODEX_OAUTH_LOGIN_FAILED';
      finish(attempt, {
        code,
        error:
          code === 'CODEX_OAUTH_STORAGE_MISMATCH'
            ? error.message
            : 'Could not start ChatGPT sign-in. Check that Codex is installed, or set CODEX_BIN to its executable.',
      });
      return { ...status(), started: false, pending: false };
    }
  }

  return {
    status,
    start,
    dispose() {
      disposed = true;
      if (!active) return;
      const attempt = active;
      finish(attempt, null);
      attempt.process?.cancel();
    },
  };
}
