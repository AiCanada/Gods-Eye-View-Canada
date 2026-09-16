import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  commandCompletedSuccessfully,
  parseWindowsUserSid,
} from './keySetupCore.mjs';

/** PowerShell verification for the exact owner-only Windows credential DACL. */
const WINDOWS_ACL_VERIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // Load Microsoft.PowerShell.Security (Get-Acl) from the module tree of the
  // interpreter that is actually running. $PSHOME is that interpreter's own
  // physical directory, so this is correct even when the executable was named
  // through the Sysnative bridge, and it cannot be steered by anything the
  // parent environment set.
  "$env:PSModulePath = Join-Path $PSHOME 'Modules'",
  '$acl = Get-Acl -LiteralPath $env:GEV_ACL_FILE',
  'if (-not $acl.AreAccessRulesProtected) { exit 2 }',
  "$allowed = @($env:GEV_ACL_USER_SID, 'S-1-5-18', 'S-1-5-32-544')",
  '$seen = @{}',
  '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
  'if ($rules.Count -ne 3) { exit 7 }',
  'foreach ($rule in $rules) {',
  '  $ruleSid = $rule.IdentityReference.Value',
  '  if ($rule.IsInherited) { exit 3 }',
  '  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 4 }',
  '  if ($allowed -notcontains $ruleSid) { exit 5 }',
  '  if ($seen.ContainsKey($ruleSid)) { exit 8 }',
  '  $full = [System.Security.AccessControl.FileSystemRights]::FullControl',
  '  if ($rule.FileSystemRights -ne $full) { exit 6 }',
  '  $seen[$ruleSid] = $true',
  '}',
  'if ($seen.Count -ne 3) { exit 9 }',
].join('; ');

/**
 * Resolve the native Windows ACL tools without consulting PATH.
 *
 * Provider Settings supports the standard Windows installation layout only:
 * a local drive root named `Windows` (for example C:\\Windows or D:\\Windows).
 * Requiring consistent aliases, canonical paths, and regular files prevents an
 * inherited environment override, UNC share, device path, junction, or PATH
 * shim from being treated as an operating-system security tool.
 */
function resolveWindowsNativeTools(environment, fileSystem, architecture) {
  const aliases = ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir'];
  const configured = aliases
    .map((name) => environment[name])
    .filter((value) => typeof value === 'string' && value.length > 0);
  if (configured.length === 0) return null;

  const roots = configured.map((value) => {
    if (value !== value.trim() || !/^[A-Za-z]:\\Windows\\?$/i.test(value))
      return null;
    return value.endsWith('\\') ? value.slice(0, -1) : value;
  });
  if (roots.some((root) => !root)) return null;
  if (roots.some((root) => root.toLowerCase() !== roots[0].toLowerCase()))
    return null;

  const systemRoot = roots[0];
  const systemDirectory = architecture === 'ia32' ? 'Sysnative' : 'System32';
  const expected = {
    whoami: path.win32.join(systemRoot, systemDirectory, 'whoami.exe'),
    icacls: path.win32.join(systemRoot, systemDirectory, 'icacls.exe'),
    powershell: path.win32.join(
      systemRoot,
      systemDirectory,
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
  };

  try {
    const realpath = fileSystem.realpathSync.native || fileSystem.realpathSync;
    const rootEntry = fileSystem.lstatSync(systemRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return null;
    const canonicalRoot = realpath.call(fileSystem.realpathSync, systemRoot);
    if (canonicalRoot.toLowerCase() !== systemRoot.toLowerCase()) return null;
    for (const executable of Object.values(expected)) {
      const entry = fileSystem.lstatSync(executable);
      if (!entry.isFile() || entry.isSymbolicLink()) return null;
      const canonicalExecutable = realpath.call(
        fileSystem.realpathSync,
        executable,
      );
      const canonicalCandidates = [executable];
      if (architecture === 'ia32') {
        canonicalCandidates.push(
          executable.replace('\\Sysnative\\', '\\System32\\'),
        );
      }
      if (
        !canonicalCandidates.some(
          (candidate) =>
            candidate.toLowerCase() === canonicalExecutable.toLowerCase(),
        )
      )
        return null;
    }
  } catch {
    return null;
  }
  return expected;
}

/**
 * Restrict a credential file before any secret is written to it.
 * Dependencies are injectable so every fail-closed branch is unit-testable.
 */
export function hardenCredentialFile(
  filepath,
  {
    platform = process.platform,
    architecture = process.arch,
    spawn = spawnSync,
    fileSystem = fs,
    environment = process.env,
  } = {},
) {
  if (platform !== 'win32') {
    try {
      if (platform === 'darwin') {
        const aclRemoval = spawn('chmod', ['-N', filepath], {
          stdio: 'ignore',
        });
        if (!commandCompletedSuccessfully(aclRemoval)) return false;
      }
      fileSystem.chmodSync(filepath, 0o600);
      return (fileSystem.statSync(filepath).mode & 0o777) === 0o600;
    } catch {
      return false;
    }
  }

  const tools = resolveWindowsNativeTools(
    environment,
    fileSystem,
    architecture,
  );
  if (!tools) return false;

  try {
    // Grant by the CURRENT PROCESS TOKEN'S SID, never a bare username. Parsing
    // the second CSV field structurally prevents an SID-looking account name or
    // a broad group SID from becoming the credential owner.
    const whoami = spawn(tools.whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const sid = commandCompletedSuccessfully(whoami)
      ? parseWindowsUserSid(whoami.stdout)
      : null;
    if (!sid) return false;

    const applied = spawn(
      tools.icacls,
      [
        filepath,
        '/inheritance:r',
        '/grant:r',
        `*${sid}:F`,
        '*S-1-5-18:F',
        '*S-1-5-32-544:F',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    if (!commandCompletedSuccessfully(applied)) return false;

    // Command success is not proof of the resulting DACL. Query it back and
    // accept only three explicit FullControl allow principals, with inheritance
    // disabled. Any unexpected rule, right, command error, or missing principal
    // fails closed before the secret reaches disk.
    //
    // The verify process must load Microsoft.PowerShell.Security (Get-Acl)
    // from the Windows PowerShell system module tree ONLY. A side-by-side
    // PowerShell 7 install prepends its own module trees to PSModulePath at
    // startup; inherited into a 5.1 process, the incompatible 7.x manifest
    // cannot be autoloaded and the verify step fails. The script itself sets
    // the path from $PSHOME; this is the same value computed ahead of time, so
    // nothing inherited is in force even for the moment before it runs. The
    // Sysnative spelling is a 32-bit caller's bridge and not a directory the
    // launched native process can read, so the physical name is used.
    const powershellModuleDirectory = path.win32.join(
      path.win32
        .dirname(tools.powershell)
        .replace(/\\Sysnative\\/i, '\\System32\\'),
      'Modules',
    );
    // Windows environment names are case-insensitive, and a child can end up
    // carrying a differently cased alias alongside the value set here. Drop
    // every spelling before setting the trusted one.
    const verifyEnvironment = Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) => name.toLowerCase() !== 'psmodulepath',
      ),
    );
    const verified = spawn(
      tools.powershell,
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_VERIFY_SCRIPT],
      {
        env: {
          ...verifyEnvironment,
          GEV_ACL_FILE: filepath,
          GEV_ACL_USER_SID: sid,
          PSModulePath: powershellModuleDirectory,
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    return commandCompletedSuccessfully(verified);
  } catch {
    return false;
  }
}

/** Rename errors Windows raises when the caller lacks DELETE on the target. */
const REPLACE_REFUSED_CODES = new Set(['EPERM', 'EACCES']);

function pathExists(fileSystem, filepath) {
  try {
    fileSystem.lstatSync(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace a credential store's content atomically.
 *
 * A fresh same-directory temp file is created 0600 with the exclusive flag,
 * hardened BEFORE the secret touches it, written in full, fsynced, then
 * renamed over the target. That closes the window where a plain writeFileSync
 * leaves a world-readable file holding a real key, and the truncate-in-place
 * data-loss path: on any failure the previous store is untouched and the
 * staged temp is removed.
 *
 * Windows replaces a file through rename only when the caller holds DELETE on
 * the target. A store whose DACL was tightened by hand to, say, (R,W) is still
 * writable yet refuses the swap with EPERM. The store is this panel's own
 * credential file and every store it writes carries the owner-only DACL the
 * hardener applies, so on that refusal the target is hardened in place — the
 * DACL the staged file already has — and the rename is retried once. A second
 * refusal fails closed with its own path-free message.
 *
 * Dependencies are injectable so every fail-closed branch is unit-testable.
 *
 * @param {string} filepath Target store path.
 * @param {string} text Full store content to write, UTF-8.
 * @returns {void}
 */
export function replaceCredentialStore(
  filepath,
  text,
  {
    fileSystem = fs,
    platform = process.platform,
    harden = hardenCredentialFile,
    tempSuffix = () => randomUUID().slice(0, 8),
  } = {},
) {
  // Never write THROUGH a symlink into a credential path.
  try {
    if (fileSystem.lstatSync(filepath).isSymbolicLink()) {
      throw new Error('refusing to write a credential store that is a symlink');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error; // absent is fine — first save.
  }
  // Random suffix, not the pid: a stale temp from a failed rename would
  // otherwise make every later save in this process fail EEXIST forever.
  const tmp = path.join(
    path.dirname(filepath),
    `.${path.basename(filepath)}.${tempSuffix()}.tmp`,
  );
  const fd = fileSystem.openSync(tmp, 'wx', 0o600);
  let staged = false;
  try {
    // Restrict the EMPTY temp file BEFORE the secret touches it. On Windows
    // a fresh file inherits the directory's ACL (world-readable under a
    // C:-rooted Pinokio home) and the 0600 open mode is a no-op — and NTFS
    // renames carry the file object's ACL with it, so hardening the temp IS
    // hardening the final file. Ordering this before the write means a
    // hardening failure aborts with the previous store fully intact and the
    // secret never on disk unprotected — no rollback path to get wrong.
    if (!harden(tmp)) {
      const error = new Error(
        'could not restrict the credential file to your account; nothing was saved',
      );
      error.code = 'GEV_HARDEN_FAILED';
      throw error;
    }
    // writeSync may write fewer bytes than asked; loop until the whole
    // buffer lands or a truncated store gets fsynced and renamed into place.
    const buffer = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < buffer.length) {
      written += fileSystem.writeSync(
        fd,
        buffer,
        written,
        buffer.length - written,
      );
    }
    fileSystem.fsyncSync(fd);
    staged = true;
  } finally {
    fileSystem.closeSync(fd);
    if (!staged) fileSystem.rmSync(tmp, { force: true });
  }

  let failure;
  try {
    fileSystem.renameSync(tmp, filepath);
    return;
  } catch (error) {
    failure = error;
  }

  if (
    platform === 'win32' &&
    REPLACE_REFUSED_CODES.has(failure?.code) &&
    pathExists(fileSystem, filepath)
  ) {
    let repaired = false;
    try {
      repaired = harden(filepath) === true;
    } catch {
      repaired = false;
    }
    if (repaired) {
      try {
        fileSystem.renameSync(tmp, filepath);
        return;
      } catch (error) {
        failure = error;
      }
    }
    // Never strand a staged secret on disk when the swap itself fails.
    fileSystem.rmSync(tmp, { force: true });
    const refused = new Error(
      'the existing configuration file could not be replaced because its permissions block the swap; nothing was saved',
    );
    refused.code = 'GEV_STORE_REPLACE_REFUSED';
    refused.cause = failure;
    throw refused;
  }

  fileSystem.rmSync(tmp, { force: true });
  throw failure;
}
