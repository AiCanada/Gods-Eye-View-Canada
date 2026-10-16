/**
 * The world tape's store (owner request 2026-10-13, "use all feeds"): every
 * live feed's records, as recorded, under .gev-data/tape/
 * (docs/WORLD-MODEL-DATA.md, World tape). Records go to
 * `<feed>/YYYY/MM/DD/HH.ndjson.gz` as one gzip member per write (a reader
 * sees whole members only, so a crash never leaves half a record), files
 * (frames, rasters, grids) to `<feed>/YYYY/MM/DD/HH/`, one manifest line per
 * write to `<feed>/YYYY/MM/DD/manifest.jsonl`, and pauses to `gaps.jsonl`.
 * At the cap or a feed's quota the write is refused, never older data
 * deleted: removal is the tab's DELETE, with its preview.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const pad = (n) => String(n).padStart(2, '0');

/** `YYYY/MM/DD` and the hour, in UTC. */
export function tapeDay(ms) {
  const d = new Date(ms);
  return {
    day: `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`,
    hour: pad(d.getUTCHours()),
  };
}

const safeName = (name) =>
  String(name)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120) || 'file';

/** Bytes and files under `dir`, walked once. */
export function folderUsage(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (at) => {
    let entries = [];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/**
 * @param {object} options
 * @param {string} options.root `.gev-data/tape`.
 * @param {() => number} [options.now]
 * @param {number} [options.capBytes] The whole tape's cap.
 * @param {Record<string, number>} [options.quotas] Per feed, in bytes.
 * @param {() => number} [options.otherBytes] Bytes the rest of .gev-data
 *   holds (datasets, models), counted against the same cap.
 */
export function createTapeStore({
  root,
  now = Date.now,
  capBytes = 600e9,
  quotas = {},
  otherBytes = () => 0,
}) {
  const usage = new Map(); // feed → { bytes, files, records, recordsToday, bytesToday, today }
  let scanned = false;
  let cap = capBytes;

  const feedUsage = (feed) => {
    if (!usage.has(feed))
      usage.set(feed, {
        bytes: 0,
        files: 0,
        records: 0,
        recordsToday: 0,
        bytesToday: 0,
        today: null,
      });
    return usage.get(feed);
  };
  const scan = () => {
    if (scanned) return;
    scanned = true;
    let feeds = [];
    try {
      feeds = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory());
    } catch {
      return;
    }
    for (const entry of feeds) {
      const u = folderUsage(path.join(root, entry.name));
      const f = feedUsage(entry.name);
      f.bytes = u.bytes;
      f.files = u.files;
    }
  };
  const total = () => {
    scan();
    let sum = 0;
    for (const f of usage.values()) sum += f.bytes;
    return sum;
  };
  const roll = (f, day) => {
    if (f.today !== day) {
      f.today = day;
      f.recordsToday = 0;
      f.bytesToday = 0;
    }
  };

  /** Whether `feed` may write `bytes` more (cap and quota). */
  const room = (feed, bytes = 0) => {
    scan();
    if (total() + otherBytes() + bytes > cap) return 'cap';
    const quota = quotas[feed];
    if (quota && feedUsage(feed).bytes + bytes > quota) return 'quota';
    return null;
  };

  const account = (u, t, bytes, records, files) => {
    const { day } = tapeDay(t);
    roll(u, day);
    u.bytes += bytes;
    u.files += files;
    u.records += records;
    u.recordsToday += records;
    u.bytesToday += bytes;
  };

  const store = {
    root,
    setCap(bytes) {
      cap = bytes;
    },
    get capBytes() {
      return cap;
    },
    /**
     * Append records (each gets t, feed, class and licence when missing).
     * `at` files them under another hour than now (a backfill files each
     * hour of the past under its own hour). Returns { ok, bytes } or
     * { ok: false, reason: 'cap' | 'quota' }.
     */
    append(feed, records, { class: cls, licence } = {}, { at } = {}) {
      if (!records?.length) return { ok: true, bytes: 0, records: 0 };
      const t = Number.isFinite(at) ? at : now();
      const lines = records
        .map((r) =>
          JSON.stringify({
            t: r.t ?? t,
            feed,
            class: r.class ?? cls,
            licence: r.licence ?? licence,
            ...r,
          }),
        )
        .join('\n');
      const member = zlib.gzipSync(Buffer.from(`${lines}\n`));
      const why = room(feed, member.length);
      if (why) return { ok: false, reason: why };
      const { day, hour } = tapeDay(t);
      const dir = path.join(root, feed, day);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${hour}.ndjson.gz`);
      const fresh = !fs.existsSync(file);
      fs.appendFileSync(file, member);
      const manifest = `${JSON.stringify({ t, hour, records: records.length, bytes: member.length, files: 0 })}\n`;
      fs.appendFileSync(path.join(dir, 'manifest.jsonl'), manifest);
      account(
        feedUsage(feed),
        t,
        member.length + manifest.length,
        records.length,
        fresh ? 1 : 0,
      );
      return { ok: true, bytes: member.length, records: records.length };
    },
    /**
     * Write a file (frame, raster, grid) and a record that points to it.
     * `at` files both under another hour than now, as append's does (a
     * backfill files each grid or image under the hour it shows).
     */
    writeFile(
      feed,
      name,
      bytes,
      record = {},
      { class: cls, licence } = {},
      { at } = {},
    ) {
      const why = room(feed, bytes.length);
      if (why) return { ok: false, reason: why };
      const t = Number.isFinite(at) ? at : now();
      const { day, hour } = tapeDay(t);
      const dir = path.join(root, feed, day, hour);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, safeName(name));
      fs.writeFileSync(file, bytes);
      account(feedUsage(feed), t, bytes.length, 0, 1);
      const rel = path.relative(root, file).replace(/\\/g, '/');
      // The record and its manifest line go under the file's own hour.
      const written = store.append(
        feed,
        [{ ...record, file: rel, bytes: bytes.length }],
        { class: cls, licence },
        { at: t },
      );
      return { ok: written.ok, bytes: bytes.length, file: rel };
    },
    /**
     * A poll that found nothing new: a manifest line with no records, so a
     * quiet hour reads as observed (zero), not as missing (NaN).
     */
    heartbeat(feed) {
      const t = now();
      const { day, hour } = tapeDay(t);
      const dir = path.join(root, feed, day);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, 'manifest.jsonl'),
        `${JSON.stringify({ t, hour, records: 0, bytes: 0, files: 0 })}\n`,
      );
    },
    /** The hours of a day a feed was polled (manifest lines), 0–23. */
    observedHours(feed, day) {
      const hours = new Set();
      try {
        for (const line of fs
          .readFileSync(path.join(root, feed, day, 'manifest.jsonl'), 'utf8')
          .split('\n'))
          if (line.trim()) hours.add(Number(JSON.parse(line).hour));
      } catch {
        /* nothing that day */
      }
      return hours;
    },
    /** A pause, stop or restart: the hours no feed was recorded. */
    gap(from, to, reason, feeds = []) {
      if (!(to > from)) return;
      fs.mkdirSync(root, { recursive: true });
      fs.appendFileSync(
        path.join(root, 'gaps.jsonl'),
        `${JSON.stringify({ from, to, reason, feeds })}\n`,
      );
    },
    gaps() {
      try {
        return fs
          .readFileSync(path.join(root, 'gaps.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    room,
    usage() {
      scan();
      const t = now();
      const { day } = tapeDay(t);
      const byFeed = {};
      for (const [feed, u] of usage) {
        roll(u, day);
        byFeed[feed] = { ...u };
      }
      return { usedBytes: total(), byFeed };
    },
    /** Forget the counts (after a delete). */
    rescan() {
      usage.clear();
      scanned = false;
    },
  };
  return store;
}
