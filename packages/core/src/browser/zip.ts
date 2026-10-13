// packages/core/src/browser/zip.ts
//
// A zip reader for exactly one input: Chrome for Testing's
// chrome-headless-shell-<platform>.zip. Those zips are deflate or stored, no
// zip64 (120 MB, 287 entries on linux64), no symlinks (verified with zipinfo
// on linux64 and mac-arm64, 2026-10-13). Anything else is refused rather
// than guessed at. ~100 lines beats a dependency whose other 95% we never
// call, and `unzip` is absent from minimal Linux images.
//
// The download is checksum-pinned, but the extractor still treats the archive
// as hostile: zip-slip, symlinks and size bombs are refused, not trusted away.
//
// zlib.crc32 needs Node 22.2 (the engines floor).

import { inflateRawSync, crc32 } from 'node:zlib';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface ZipEntry {
  name: string;
  /** POSIX mode from the external attributes (0 when the zip has none). */
  mode: number;
  isDirectory: boolean;
  data: Buffer;
}

export interface ZipLimits {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

// The largest file in a linux64 headless shell is ~270 MB uncompressed and the
// whole tree ~ 330 MB; 1 GiB / 2 GiB leave headroom without admitting a bomb.
export const MAX_ENTRY_BYTES = 1024 ** 3;
export const MAX_TOTAL_BYTES = 2 * 1024 ** 3;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const corrupt = (why: string): Error => new Error(`zip: corrupt archive (${why})`);

export function readZip(buf: Buffer, limits: ZipLimits = {}): ZipEntry[] {
  try {
    return readZipUnchecked(buf, limits);
  } catch (err) {
    // Every read is bounds-checked below; this is the net for the one we missed.
    if (err instanceof RangeError) throw corrupt('read out of range');
    throw err;
  }
}

function readZipUnchecked(buf: Buffer, limits: ZipLimits): ZipEntry[] {
  const maxEntry = limits.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxTotal = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  // The end-of-central-directory record is within the last 64 KiB (comment),
  // and its comment length must account for every byte after it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (
      buf.readUInt32LE(i) === EOCD &&
      i + 22 + buf.readUInt16LE(i + 20) === buf.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  if (cdStart > eocd || cdStart + cdSize > eocd) throw corrupt('central directory');
  const cdEnd = cdStart + cdSize;
  let p = cdStart;
  let total = 0;
  const entries: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > cdEnd) throw corrupt('central directory entry');
    if (buf.readUInt32LE(p) !== CENTRAL) throw corrupt('bad central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen + xlen + clen > cdEnd) throw corrupt('central directory entry');
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) {
      throw new Error('zip: zip64 is not supported');
    }
    if (flags & 1) throw new Error(`zip: encrypted entry ${name}`);
    if (method !== 0 && method !== 8)
      throw new Error(`zip: unsupported compression method ${method} for ${name}`);
    if (usize > maxEntry) throw new Error(`zip: entry too large: ${name}`);
    total += usize;
    if (total > maxTotal) throw new Error('zip: total uncompressed size too large');

    if (local + 30 > cdStart) throw corrupt(`local header for ${name}`);
    if (buf.readUInt32LE(local) !== LOCAL) throw corrupt(`bad local header for ${name}`);
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > cdStart) throw corrupt(`data for ${name}`);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) {
      if (csize !== usize) throw new Error(`zip: crc mismatch for ${name}`);
      data = Buffer.from(raw);
    } else {
      // Bound inflate by the cap, not by the header's claim: a bomb can lie.
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
          throw new Error(`zip: entry too large: ${name}`, { cause: err });
        throw err;
      }
    }
    if (data.length !== usize || crc32(data) !== crc)
      throw new Error(`zip: crc mismatch for ${name}`);
    entries.push({ name, mode: attrs >>> 16, isDirectory: name.endsWith('/'), data });
  }
  return entries;
}

/** Throws unless `name` is a relative, forward-slash path that stays inside `root`. */
function safeTarget(root: string, name: string): string {
  // Backslash is a separator on Windows and a literal elsewhere; CfT zips use
  // neither, so refuse it everywhere rather than reason about both.
  if (name.includes('\0')) throw new Error(`zip: NUL byte in entry name`);
  if (name.includes('\\')) throw new Error(`zip: backslash in entry name ${name}`);
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name))
    throw new Error(`zip: absolute entry name ${name}`);
  const target = path.resolve(root, name);
  if (
    name.split('/').includes('..') ||
    (target !== root && !target.startsWith(root + path.sep))
  )
    throw new Error(`zip: entry escapes the target (..): ${name}`);
  if (target === root) throw new Error(`zip: entry resolves to the root: ${name}`);
  return target;
}

export async function extractZip(
  buf: Buffer,
  dir: string,
  limits: ZipLimits = {},
): Promise<string[]> {
  const root = path.resolve(dir);
  // Validate every entry before writing any: a hostile zip leaves nothing behind.
  const explicit = new Set<string>();
  const kinds = new Map<string, 'file' | 'dir'>();
  const claim = (t: string, kind: 'file' | 'dir', name: string): void => {
    const prev = kinds.get(t);
    if (prev && prev !== kind) throw new Error(`zip: file/dir collision at ${name}`);
    kinds.set(t, kind);
  };
  const plan = readZip(buf, limits).map((e) => {
    const target = safeTarget(root, e.name);
    if ((e.mode & S_IFMT) === S_IFLNK)
      throw new Error(`zip: symlink entry refused: ${e.name}`);
    if (explicit.has(target)) throw new Error(`zip: duplicate entry ${e.name}`);
    explicit.add(target);
    claim(target, e.isDirectory ? 'dir' : 'file', e.name);
    for (
      let d = path.dirname(target);
      d !== root && d.startsWith(root);
      d = path.dirname(d)
    )
      claim(d, 'dir', e.name);
    return { e, target };
  });
  const written: string[] = [];
  for (const { e, target } of plan) {
    if (e.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const mode = e.mode & 0o777 || 0o644;
    await writeFile(target, e.data, { mode });
    // writeFile's mode is masked by the umask; chmod is not. No-op on Windows.
    await chmod(target, mode);
    written.push(target);
  }
  return written;
}

export interface InstallOptions extends ZipLimits {
  /** File written (inside the temp dir, before the swap) so a completed install is always marked. */
  marker?: string;
}

const isRaceError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM';
};

/**
 * Extract into a sibling temp dir, then swap it into `finalDir`, so a crash
 * mid-extract never leaves a half-written browser at the path resolve reads.
 * Any existing `finalDir` (dir, file or symlink) is renamed aside first and
 * removed after, so there is no window with nothing in place. If a concurrent
 * installer wins the final rename, its target is complete and ours is dropped.
 */
export async function installZip(
  buf: Buffer,
  finalDir: string,
  opts: InstallOptions = {},
): Promise<string[]> {
  const parent = path.dirname(path.resolve(finalDir));
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(path.join(parent, `.${path.basename(finalDir)}-tmp-`));
  let aside: string | undefined;
  try {
    const written = await extractZip(buf, tmp, opts);
    if (opts.marker) await writeFile(path.join(tmp, opts.marker), '');
    const out = written.map((w) => path.join(finalDir, path.relative(tmp, w)));
    const old = `${finalDir}.old-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      await rename(finalDir, old);
      aside = old;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      await rename(tmp, finalDir);
      return out;
    } catch (err) {
      if (!isRaceError(err)) {
        if (aside) await rename(aside, finalDir).catch(() => undefined);
        aside = undefined;
        throw err;
      }
      // Someone else installed between our rename-aside and rename-in.
      // Their dir is complete (marker included); keep it.
      if (aside) {
        await rm(aside, { recursive: true, force: true });
        aside = undefined;
      }
      await rm(tmp, { recursive: true, force: true });
      return out;
    } finally {
      if (aside) await rm(aside, { recursive: true, force: true });
    }
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}
