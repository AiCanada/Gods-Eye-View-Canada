/**
 * DELETE for the Artificial Intelligence World Training Sim tab (owner
 * request 2026-10-13: "Delete (showing data to be deleted)"). The preview
 * lists exactly what would go — by group, with files and bytes — and a
 * token bound to that listing; the delete lists again, refuses if anything
 * changed, and removes only those files, only inside .gev-data, never
 * through a link out of it. The tab's job state and areas stay.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** What each scope covers, as folders under .gev-data (one group each). */
const SCOPE_PARTS = {
  tape: [{ kind: 'tape', dir: 'tape', each: true }],
  bins: [{ kind: 'bins', dir: 'bins', each: true }],
  datasets: [{ kind: 'datasets', dir: 'outbreak/datasets', each: true }],
  worlds: [{ kind: 'worlds', dir: 'outbreak/worlds', each: true }],
  models: [{ kind: 'models', dir: 'ai-world/models', each: true }],
  predictions: [
    { kind: 'predictions', dir: 'ai-world/predictions', each: false },
  ],
  demographics: [{ kind: 'demographics', dir: 'demographics', each: false }],
};
/** What each scope covers, as folders under .gev-data (one group each). */
export const DELETE_SCOPES = Object.freeze({
  ...SCOPE_PARTS,
  all: Object.values(SCOPE_PARTS).flat(),
});

/** Whether `target` is `root` or inside it (resolved paths). */
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Every file under `dir` (links are listed as themselves, never followed). */
function filesUnder(root, dir) {
  const out = [];
  const walk = (at) => {
    let entries = [];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (!inside(root, full)) continue;
      if (entry.isDirectory()) walk(full);
      else {
        let stat;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        out.push({
          path: path.relative(root, full).replace(/\\/g, '/'),
          bytes: stat.isSymbolicLink() ? 0 : stat.size,
          mtimeMs: Math.floor(stat.mtimeMs),
        });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The listing for a scope: groups (kind, id, path, files, bytes), totals,
 * every file, and the token over them.
 */
export function listForDelete(dataRoot, scope = 'all') {
  const plan = DELETE_SCOPES[scope];
  if (!plan) throw new Error(`Unknown scope: ${scope}`);
  const root = path.resolve(dataRoot);
  const groups = [];
  const files = [];
  for (const { kind, dir, each } of plan) {
    const base = path.resolve(root, dir);
    if (!inside(root, base) || !fs.existsSync(base)) continue;
    const parts = each
      ? fs.readdirSync(base, { withFileTypes: true }).map((e) => ({
          id: e.name,
          at: path.join(base, e.name),
          isDir: e.isDirectory(),
        }))
      : [{ id: path.basename(base), at: base, isDir: true }];
    for (const part of parts) {
      const list = part.isDir
        ? filesUnder(root, part.at)
        : filesUnder(root, path.dirname(part.at)).filter(
            (f) => f.path === path.relative(root, part.at).replace(/\\/g, '/'),
          );
      if (!list.length) continue;
      groups.push({
        kind,
        id: part.id,
        path: path.relative(root, part.at).replace(/\\/g, '/'),
        files: list.length,
        bytes: list.reduce((s, f) => s + f.bytes, 0),
      });
      files.push(...list);
    }
  }
  const hash = createHash('sha256');
  for (const f of files) hash.update(`${f.path}\0${f.bytes}\0${f.mtimeMs}\n`);
  return {
    scope,
    token: hash.digest('hex'),
    root: path.basename(root),
    groups,
    totalFiles: files.length,
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
    files,
  };
}

/** The preview the tab shows (no per-file list). */
export function deletePreview(dataRoot, scope = 'all') {
  const { files: _files, ...preview } = listForDelete(dataRoot, scope);
  return preview;
}

/**
 * Delete exactly what `token` listed. Returns { files, bytes } or throws an
 * error with `status` 409 when the listing changed.
 */
export function deleteListed(dataRoot, scope, token) {
  const root = path.resolve(dataRoot);
  const listing = listForDelete(root, scope);
  if (!token || listing.token !== token) {
    const error = new Error(
      'The data changed since the preview: preview again before deleting.',
    );
    error.status = 409;
    throw error;
  }
  let files = 0;
  let bytes = 0;
  const dirs = new Set();
  for (const f of listing.files) {
    const full = path.resolve(root, f.path);
    if (!inside(root, full)) continue;
    try {
      fs.rmSync(full, { force: true });
      files += 1;
      bytes += f.bytes;
      for (
        let d = path.dirname(full);
        inside(root, d) && d !== root;
        d = path.dirname(d)
      )
        dirs.add(d);
    } catch {
      /* gone already */
    }
  }
  // Folders left empty, deepest first; a folder with anything new stays.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(d);
    } catch {
      /* not empty */
    }
  }
  return { files, bytes };
}
