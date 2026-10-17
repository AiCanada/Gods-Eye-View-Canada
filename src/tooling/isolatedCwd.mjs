import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Imported first by a test file whose modules fix machine paths from the
 * working folder when they load or are built (the Overpass, military
 * installation and other disk caches under .gev-cache, .env, the config files
 * a provider resolves from the working folder): the test process moves into an
 * empty temp folder before any of them loads, so the test neither reads nor
 * writes this machine's caches and config. Repository files are still found
 * through import.meta.url. Each test file runs in its own process, so the
 * move stays inside that file; the folder is removed when the process exits.
 */
const home = process.cwd();

/** The empty folder the test process works in. */
export const isolatedCwd = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'gev-test-cwd-')),
);
process.chdir(isolatedCwd);
process.once('exit', () => {
  try {
    process.chdir(home);
    rmSync(isolatedCwd, { recursive: true, force: true });
  } catch {
    // A folder still in use is left to the system's temp cleanup.
  }
});
