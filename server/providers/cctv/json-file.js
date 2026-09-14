import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Read and parse a JSON file. A missing, unreadable or malformed file is null:
 * every CCTV disk cache treats that as "nothing cached yet".
 *
 * @param {string} file
 * @returns {Promise<any|null>}
 */
export async function readJsonFile(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write JSON beside the live file and rename it over, so a reader during the
 * write, or a crash mid-write, never sees a truncated file. Same directory, so
 * the rename is atomic on POSIX and a replace on Windows.
 *
 * @param {string} file
 * @param {unknown} value
 * @returns {Promise<boolean>} Whether the file was written.
 */
export async function writeJsonFileAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(temp, JSON.stringify(value), 'utf8');
    await fsp.rename(temp, file);
    return true;
  } catch {
    await fsp.rm(temp, { force: true }).catch(() => {});
    return false;
  }
}
