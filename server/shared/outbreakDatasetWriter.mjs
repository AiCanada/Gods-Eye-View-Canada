/**
 * Shard files for world-model datasets (owner request 2026-10-13): a
 * gzip-compressed tar of episode members, written to `<file>.partial` and
 * renamed when complete, so a shard on disk is always whole. The same
 * members in the same order always give the same bytes.
 */
import fs from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import zlib from 'node:zlib';
import { tarEnd, tarMember } from '../../src/outbreakEpiShard.mjs';

export function createShardWriter(file, { level = 6 } = {}) {
  const partial = `${file}.partial`;
  const gzip = zlib.createGzip({ level });
  const out = fs.createWriteStream(partial);
  gzip.pipe(out);
  let raw = 0;
  let closed = false;
  return {
    get rawBytes() {
      return raw;
    },
    async add(name, bytes) {
      const member = tarMember(name, bytes);
      raw += member.length;
      if (!gzip.write(member)) await once(gzip, 'drain');
    },
    async finish() {
      if (closed) throw new Error('shard: already closed');
      closed = true;
      gzip.end(tarEnd());
      await finished(out);
      fs.renameSync(partial, file);
      return fs.statSync(file).size;
    },
    abort() {
      if (closed) return;
      closed = true;
      gzip.destroy();
      out.destroy();
      fs.rmSync(partial, { force: true });
    },
  };
}
