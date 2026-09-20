#!/usr/bin/env node
// Copies the GEV Private_CCTV_Feed Relay Chrome extension (tools/private-cctv-feed-relay) to a
// fixed per-user folder. Chrome derives an unpacked extension's ID from its
// folder, so a fixed folder keeps the ID, and the pairing, stable across updates.
import { spawnSync } from 'node:child_process';
import {
  PRIVATE_CCTV_FEED_LOCAL_CONFIG,
  parsePrivateCctvFeedConfig,
  renderRelayConfigScript,
  renderRelayManifest,
} from '../src/privateCctvFeedConfig.mjs';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(MODULE_PATH), '..');

export const RELAY_SOURCE_DIR = path.join(
  ROOT,
  'tools',
  'private-cctv-feed-relay',
);
export const RELAY_EXTRA_FILES = Object.freeze([
  'manifest.json',
  'options.html',
  'options.js',
  'options.css',
]);

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

/** Windows folder settings files that Chrome refuses inside an extension ("The filename is illegal"). */
export const WINDOWS_FOLDER_METADATA = Object.freeze([
  'desktop.ini',
  'thumbs.db',
]);

/** The flat list of files the extension needs: those its manifest names plus the options page. */
export function relayInstallFiles(manifest) {
  const files = new Set();
  const add = (name) => {
    if (typeof name !== 'string' || !SAFE_FILE_NAME.test(name)) {
      throw new Error(
        `Refusing unexpected extension file name: ${JSON.stringify(name)}`,
      );
    }
    files.add(name);
  };
  RELAY_EXTRA_FILES.forEach(add);
  if (manifest?.background?.service_worker !== undefined)
    add(manifest.background.service_worker);
  for (const script of manifest?.content_scripts ?? []) {
    for (const name of script?.js ?? []) add(name);
    for (const name of script?.css ?? []) add(name);
  }
  if (manifest?.options_page !== undefined) add(manifest.options_page);
  if (manifest?.options_ui?.page !== undefined) add(manifest.options_ui.page);
  return [...files].sort();
}

/** %LOCALAPPDATA%\GEV\private-cctv-feed-relay on Windows, else $XDG_DATA_HOME/gev/private-cctv-feed-relay or ~/.local/share/gev/private-cctv-feed-relay. */
export function relayInstallDestination({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (platform === 'win32') {
    const local =
      env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
        ? env.LOCALAPPDATA
        : path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(local, 'GEV', 'private-cctv-feed-relay');
  }
  // The XDG spec says relative values must be ignored.
  const data =
    env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : path.posix.join(homedir, '.local', 'share');
  return path.posix.join(data, 'gev', 'private-cctv-feed-relay');
}

function statWithoutFollowing(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function refuseLink(target, label) {
  const stats = statWithoutFollowing(target);
  if (stats?.isSymbolicLink())
    throw new Error(
      `Refusing to use a symbolic link or junction for ${label}: ${target}`,
    );
  return stats;
}

/**
 * Undo what Explorer and a folder's Properties leave in the install folder. A
 * read-only, hidden or system folder makes Explorer write desktop.ini into it,
 * and Chrome will not load an extension folder holding desktop.ini or Thumbs.db.
 * @returns {string[]} the settings files removed
 */
export function clearWindowsFolderMarks(
  destination,
  { platform = process.platform, run = spawnSync } = {},
) {
  if (platform === 'win32') {
    const quiet = { windowsHide: true, stdio: 'ignore' };
    run('attrib', ['-R', '-S', '-H', destination], quiet);
    run('attrib', ['-R', '-S', '-H', path.join(destination, '*')], quiet);
  }
  const removed = [];
  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !WINDOWS_FOLDER_METADATA.includes(entry.name.toLowerCase())
    )
      continue;
    const target = path.join(destination, entry.name);
    chmodSync(target, 0o666);
    unlinkSync(target);
    removed.push(entry.name);
  }
  return removed;
}

/** Copy the extension files into destination, refusing symbolic links on either side. */
export function installPrivateCctvFeedRelay({
  sourceDir = RELAY_SOURCE_DIR,
  destination = relayInstallDestination(),
  platform = process.platform,
  run = spawnSync,
  feedConfig = null,
} = {}) {
  const source = refuseLink(sourceDir, 'the extension source folder');
  if (!source?.isDirectory())
    throw new Error(`Extension source folder not found: ${sourceDir}`);
  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (!refuseLink(manifestPath, 'manifest.json')?.isFile())
    throw new Error(`Extension manifest not found: ${manifestPath}`);
  const files = relayInstallFiles(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
  );
  for (const name of files) {
    if (!refuseLink(path.join(sourceDir, name), name)?.isFile())
      throw new Error(`Extension file missing: ${name}`);
  }

  const parent = path.dirname(destination);
  refuseLink(parent, 'the install parent folder');
  refuseLink(destination, 'the install folder');
  mkdirSync(destination, { recursive: true });
  refuseLink(parent, 'the install parent folder');
  if (!refuseLink(destination, 'the install folder')?.isDirectory())
    throw new Error(`Install folder is not a folder: ${destination}`);
  const removedMetadata = clearWindowsFolderMarks(destination, {
    platform,
    run,
  });

  for (const name of files) {
    const target = path.join(destination, name);
    const existing = refuseLink(target, name);
    if (existing && !existing.isFile())
      throw new Error(
        `Refusing to replace something that is not a file: ${target}`,
      );
    if (existing) {
      // Windows will not overwrite a read-only or hidden file in place.
      chmodSync(target, 0o666);
      unlinkSync(target);
    }
    copyFileSync(path.join(sourceDir, name), target);
  }
  // The tracked copy names only example hosts. The owner's own site and picture
  // hosts are written into the INSTALLED copy, never into the repository.
  if (feedConfig?.configured) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // A copy keeps its source's read-only flag, and writing over that fails
    // (EPERM on Windows), which would leave the example hosts installed.
    for (const name of ['manifest.json', 'relay-config.js']) {
      try {
        chmodSync(path.join(destination, name), 0o666);
      } catch {
        /* not there yet, or already writable */
      }
    }
    writeFileSync(
      path.join(destination, 'manifest.json'),
      `${JSON.stringify(renderRelayManifest(manifest, feedConfig), null, 2)}\n`,
    );
    writeFileSync(
      path.join(destination, 'relay-config.js'),
      renderRelayConfigScript(feedConfig),
    );
  }
  const extras = readdirSync(destination).filter(
    (name) => !files.includes(name),
  );
  return { destination, files, removedMetadata, extras };
}

/** The owner's untracked site settings, or the example ones when there is no local file. */
export function readLocalFeedConfig(root = ROOT) {
  let raw = null;
  try {
    raw = JSON.parse(
      readFileSync(path.join(root, PRIVATE_CCTV_FEED_LOCAL_CONFIG), 'utf8'),
    );
  } catch {
    raw = null;
  }
  return parsePrivateCctvFeedConfig(raw);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const invoked = realpathSync(path.resolve(process.argv[1]));
    const self = realpathSync(MODULE_PATH);
    return process.platform === 'win32'
      ? invoked.toLowerCase() === self.toLowerCase()
      : invoked === self;
  } catch {
    return false;
  }
}

function main() {
  try {
    const feedConfig = readLocalFeedConfig();
    const { destination, files, removedMetadata, extras } =
      installPrivateCctvFeedRelay({ feedConfig });
    console.log(
      `GEV Private_CCTV_Feed Relay (${files.length} files) copied to:`,
    );
    console.log(`  ${destination}`);
    if (feedConfig.configured) {
      console.log(
        `Camera site: ${feedConfig.feedOrigin} (${feedConfig.imageHosts.length} picture hosts), from ${PRIVATE_CCTV_FEED_LOCAL_CONFIG}`,
      );
    } else {
      console.log('');
      console.log(
        `NOT CONFIGURED: no usable ${PRIVATE_CCTV_FEED_LOCAL_CONFIG}, so the installed relay names only`,
      );
      console.log(
        'example hosts and will relay nothing. Copy config/private_cctv_feed.example.json to that',
      );
      console.log(
        'name, put in your camera site feed address and its picture hosts, and run this again.',
      );
      for (const problem of feedConfig.problems) console.log(`  - ${problem}`);
    }
    if (removedMetadata.length)
      console.log(
        `Removed Windows folder settings Chrome refuses to load: ${removedMetadata.join(', ')}`,
      );
    if (extras.length)
      console.log(
        `Other files in that folder, which Chrome would load too (delete them): ${extras.join(', ')}`,
      );
    console.log('');
    console.log('Next steps:');
    console.log('  1. Open chrome://extensions and turn on Developer mode.');
    console.log(
      '  2. Choose "Load unpacked" (not "Pack extension") and paste the folder path above into the folder box.',
    );
    if (process.platform === 'win32') {
      console.log(
        '     (AppData is a hidden folder, so it does not show up when you browse to it.',
      );
      console.log(
        "     Do not change the folder's Properties: that makes Windows add desktop.ini, which Chrome refuses.)",
      );
    }
    console.log(
      '     Already loaded? Press the reload button on the extension card instead.',
    );
    console.log(
      '  3. Reload your camera site feed tab if it was already open:',
    );
    console.log(
      '     a tab opened before the extension was loaded or reloaded is not read.',
    );
    console.log(
      "  4. Open the extension's Details > Extension options and press PAIR WITH GODS EYE VIEW,",
    );
    console.log(
      '     then in GEV > POWER UP > HOME SECURITY (site set to Browser feed relay) APPROVE only the request',
    );
    console.log(
      '     whose code and extension ID both match the options page.',
    );
    console.log(
      '  5. Keep your camera site feed page open and signed in, and add that site to',
    );
    console.log(
      '     chrome://settings/performance "Always keep these sites active".',
    );
    console.log('');
    console.log(
      "Private_CCTV_Feed's terms of service prohibit data-extraction tools and allow Private_CCTV_Feed to close accounts. Use the relay at your own risk.",
    );
  } catch (error) {
    console.error(`private-cctv-feed-relay:install failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (invokedDirectly()) main();
