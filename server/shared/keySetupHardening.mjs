import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  commandCompletedSuccessfully,
  parseWindowsUserSid,
} from '../../src/keySetupCore.mjs';

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
  // A folder's three rules must also reach every file and folder inside it.
  "$folder = $env:GEV_ACL_FOLDER -eq '1'",
  "$both = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
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
  '  if ($folder -and $rule.InheritanceFlags -ne $both) { exit 10 }',
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
export function hardenCredentialFile(filepath, dependencies = {}) {
  return restrictToOwner(filepath, false, dependencies);
}

/**
 * Restrict a folder of private records (a phone's location history) to this
 * account, the same three principals a credential file gets, inherited by
 * every file and folder inside it: the ones already there, and every one
 * written later, so each write does not need the hardener again.
 */
export function hardenPrivateFolder(folder, dependencies = {}) {
  return restrictToOwner(folder, true, dependencies);
}

function restrictToOwner(
  filepath,
  folder,
  {
    platform = process.platform,
    architecture = process.arch,
    spawn = spawnSync,
    fileSystem = fs,
    environment = process.env,
  } = {},
) {
  const mode = folder ? 0o700 : 0o600;
  if (platform !== 'win32') {
    try {
      if (platform === 'darwin') {
        // `-N` (strip the ACL) is Apple-only. Spawn /bin/chmod by absolute
        // path, never by name: a Nix/Homebrew coreutils profile puts GNU chmod
        // first on PATH, and GNU chmod rejects `-N` — which was treated as a
        // hardening failure and refused every save on such machines.
        const aclRemoval = spawn('/bin/chmod', ['-N', filepath], {
          stdio: 'ignore',
        });
        if (!commandCompletedSuccessfully(aclRemoval)) return false;
      }
      fileSystem.chmodSync(filepath, mode);
      return (fileSystem.statSync(filepath).mode & 0o777) === mode;
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
    const sid = currentUserSid(tools, spawn);
    if (!sid) return false;

    // On a folder each rule is inherited by everything inside it (OI)(CI),
    // and icacls carries the change down to what is already there.
    const rights = folder ? '(OI)(CI)F' : 'F';
    const applied = spawn(
      tools.icacls,
      [
        filepath,
        '/inheritance:r',
        '/grant:r',
        `*${sid}:${rights}`,
        `*S-1-5-18:${rights}`,
        `*S-1-5-32-544:${rights}`,
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    if (!commandCompletedSuccessfully(applied)) return false;

    // Command success is not proof of the resulting DACL. Query it back and
    // accept only three explicit FullControl allow principals, with inheritance
    // disabled. Any unexpected rule, right, command error, or missing principal
    // fails closed before the secret reaches disk.
    return windowsAclVerified({
      tools,
      sid,
      filepath,
      folder,
      environment,
      spawn,
    });
  } catch {
    return false;
  }
}

/** The SID of the account this process runs as, from whoami's CSV, or null. */
function currentUserSid(tools, spawn) {
  const whoami = spawn(tools.whoami, ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return commandCompletedSuccessfully(whoami)
    ? parseWindowsUserSid(whoami.stdout)
    : null;
}

/**
 * Whether the DACL on a file or folder is exactly the owner-only one this
 * module sets: three explicit FullControl allow rules (this account, SYSTEM,
 * Administrators), inheritance disabled, nothing else.
 *
 * The verify process must load Microsoft.PowerShell.Security (Get-Acl)
 * from the Windows PowerShell system module tree ONLY. A side-by-side
 * PowerShell 7 install prepends its own module trees to PSModulePath at
 * startup; inherited into a 5.1 process, the incompatible 7.x manifest
 * cannot be autoloaded and the verify step fails. The script itself sets
 * the path from $PSHOME; this is the same value computed ahead of time, so
 * nothing inherited is in force even for the moment before it runs. The
 * Sysnative spelling is a 32-bit caller's bridge and not a directory the
 * launched native process can read, so the physical name is used.
 */
function windowsAclVerified({
  tools,
  sid,
  filepath,
  folder,
  environment,
  spawn,
}) {
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
        GEV_ACL_FOLDER: folder ? '1' : '',
        GEV_ACL_USER_SID: sid,
        PSModulePath: powershellModuleDirectory,
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  return commandCompletedSuccessfully(verified);
}

/**
 * Whether a credential file is still restricted to this account: the check
 * the hardener runs after it writes, run again on its own, with nothing
 * changed. On POSIX the file must be a regular file (not a symlink) with
 * mode exactly 0600; on Windows its DACL must be the exact owner-only one
 * (see windowsAclVerified). False on any doubt: a missing file, an
 * unreadable stat, tools that cannot be resolved. A key file whose
 * protection was widened after it was written is how a key leaks without
 * the file ever being rewritten, so the store reads this before it trusts
 * the key, and says so when it fails.
 */
export function credentialFileRestricted(
  filepath,
  {
    platform = process.platform,
    architecture = process.arch,
    spawn = spawnSync,
    fileSystem = fs,
    environment = process.env,
  } = {},
) {
  try {
    const entry = fileSystem.lstatSync(filepath);
    if (entry.isSymbolicLink?.() || entry.isDirectory?.()) return false;
  } catch {
    return false;
  }
  if (platform !== 'win32') {
    try {
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
    const sid = currentUserSid(tools, spawn);
    if (!sid) return false;
    return windowsAclVerified({
      tools,
      sid,
      filepath,
      folder: false,
      environment,
      spawn,
    });
  } catch {
    return false;
  }
}

/** Rename errors Windows raises when the caller lacks DELETE on the target. */
const REPLACE_REFUSED_CODES = new Set(['EPERM', 'EACCES']);
/**
 * Link errors that mean the volume cannot make a hard link at all (FAT and
 * exFAT on Windows, some network and FUSE mounts), as opposed to a link that
 * was refused because the name is taken. Only these fall back to a rename.
 */
const LINK_UNSUPPORTED_CODES = new Set([
  'EPERM',
  'EACCES',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EINVAL',
  'EXDEV',
]);

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
 * With `exclusive` the staged file is installed only when nothing is at the
 * target yet: the temp is hard-linked to the target name, which the file
 * system refuses with EEXIST when another process got there first, and the
 * temp is then removed. A hard link is the same file object, so the DACL or
 * mode the hardener gave the temp is the target's too. The caller sees an
 * error with code 'EEXIST' and reads the winner's file back instead of
 * replacing it: a key file made twice would seal two sets of tokens under
 * two keys. A volume that cannot make hard links (FAT, exFAT, some mounts)
 * refuses the link with EPERM, ENOSYS or the like; that one case falls back
 * to the rename above, after a look at the target, and the result says so
 * (`exclusive: false`) so the caller can log that the guarantee was weaker.
 *
 * Dependencies are injectable so every fail-closed branch is unit-testable.
 *
 * @param {string} filepath Target store path.
 * @param {string} text Full store content to write, UTF-8.
 * @param {object} [options]
 * @param {boolean} [options.exclusive] Create only; never replace a file
 *   that is already there.
 * @returns {{ method: 'link' | 'rename', exclusive: boolean, linkError?: string }}
 *   How the staged file was installed. `linkError` is the code the hard link
 *   failed with when an exclusive install had to fall back to a rename.
 */
export function replaceCredentialStore(
  filepath,
  text,
  {
    fileSystem = fs,
    platform = process.platform,
    harden = hardenCredentialFile,
    tempSuffix = () => randomUUID().slice(0, 8),
    exclusive = false,
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
  const pathFor = platform === 'win32' ? path.win32 : path.posix;
  const tmp = pathFor.join(
    pathFor.dirname(filepath),
    `.${pathFor.basename(filepath)}.${tempSuffix()}.tmp`,
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

  let linkError;
  if (exclusive) {
    try {
      fileSystem.linkSync(tmp, filepath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        fileSystem.rmSync(tmp, { force: true });
        throw targetTaken(error);
      }
      if (!LINK_UNSUPPORTED_CODES.has(error?.code)) {
        fileSystem.rmSync(tmp, { force: true });
        throw error;
      }
      // No hard links on this volume. The rename below is not exclusive, so
      // the target is looked at first; the window between the look and the
      // rename is what the caller's read-back covers.
      if (pathExists(fileSystem, filepath)) {
        fileSystem.rmSync(tmp, { force: true });
        throw targetTaken(error);
      }
      linkError = String(error?.code || 'error');
    }
    if (linkError === undefined) {
      // Both names are the same hardened file now; a temp name that will
      // not go is not a failed install, and the caller reads the target back.
      try {
        fileSystem.rmSync(tmp, { force: true });
      } catch {
        /* the target is in place either way */
      }
      return { method: 'link', exclusive: true };
    }
  }

  let failure;
  try {
    fileSystem.renameSync(tmp, filepath);
    return installedByRename(linkError);
  } catch (error) {
    failure = error;
  }

  // An exclusive install never repairs and renames over a file that appeared
  // after the look above: that file is the winner's, and the caller reads it.
  if (exclusive && pathExists(fileSystem, filepath)) {
    fileSystem.rmSync(tmp, { force: true });
    throw targetTaken(failure);
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
        return installedByRename(linkError);
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

/** The result of a rename install; `linkError` is set only after an exclusive install fell back. */
function installedByRename(linkError) {
  return linkError === undefined
    ? { method: 'rename', exclusive: false }
    : { method: 'rename', exclusive: false, linkError };
}

/** The refusal an exclusive install raises when the target already exists. */
function targetTaken(cause) {
  const taken = new Error(
    'the credential file was created by another process meanwhile; nothing was replaced',
  );
  taken.code = 'EEXIST';
  taken.cause = cause;
  return taken;
}
