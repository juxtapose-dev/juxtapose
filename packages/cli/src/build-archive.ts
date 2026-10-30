import { lstat, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { UserError } from './user-error.js';

const MAX_ARCHIVE = 16 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;

/** Stable USTAR headers omit machine ownership and timestamps from build identity. */
function header(name: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  let leaf = name,
    prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const split = name.lastIndexOf('/');
    prefix = name.slice(0, split);
    leaf = name.slice(split + 1);
    if (split < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(leaf) > 100)
      throw new UserError('Build contains a path too long for portable archives.');
  }
  block.write(leaf, 0, 100);
  block.write(prefix, 345, 155);
  const octal = (value: number, offset: number, length: number) =>
    block.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  block.fill(32, 148, 156);
  block[156] = 48;
  block.write('ustar\0', 257, 6);
  block.write('00', 263, 2);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

export async function packStorybook(directory: string): Promise<Buffer> {
  const files: { name: string; size: number }[] = [];
  let expanded = 1024;
  let entries = 0;
  async function walk(relative: string) {
    const absolute = path.join(directory, relative);
    const stat = await lstat(absolute);
    if (++entries > 10000) throw new UserError('Build exceeds 10,000 archive entries.');
    if (stat.isSymbolicLink())
      throw new UserError('Build contains a symlink; submit a self-contained build.');
    const name = path.basename(relative);
    if (/^\.env(?:\.|$)/.test(name) || ['.git', '.npmrc', '.ssh'].includes(name))
      throw new UserError(
        'Build contains a credential or repository file; submit only compiled Storybook output.',
      );
    if (stat.isDirectory()) {
      for (const child of (await readdir(absolute)).sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ))
        await walk(relative ? `${relative}/${child}` : child);
    } else if (stat.isFile()) {
      if (stat.size > MAX_FILE) throw new UserError('Build file exceeds 64 MiB.');
      expanded += 512 + Math.ceil(stat.size / 512) * 512;
      if (expanded > MAX_EXPANDED) throw new UserError('Expanded build exceeds 512 MiB.');
      files.push({ name: relative, size: stat.size });
    } else throw new UserError('Build contains an unsupported special file.');
  }
  await walk('');
  for (const required of ['index.html', 'iframe.html', 'index.json'])
    if (!files.some((file) => file.name === required))
      throw new UserError(`Storybook build is missing ${required}.`);
  async function* tar() {
    for (const file of files) {
      const handle = await open(
        path.join(directory, file.name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== file.size)
          throw new UserError(
            'Build changed while packing; finish the build before submitting.',
          );
        yield header(file.name, file.size);
        let length = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          if (!Buffer.isBuffer(chunk))
            throw new UserError('Unexpected build stream encoding.');
          length += chunk.length;
          if (length > file.size) throw new UserError('Build changed while packing.');
          yield chunk;
        }
        const after = await handle.stat();
        if (
          length !== file.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new UserError('Build changed while packing.');
        if (file.size % 512) yield Buffer.alloc(512 - (file.size % 512));
      } finally {
        await handle.close();
      }
    }
    yield Buffer.alloc(1024);
  }
  const source = Readable.from(tar());
  const gzip = createGzip();
  source.on('error', (error) => gzip.destroy(error));
  source.pipe(gzip);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of gzip) {
      if (!Buffer.isBuffer(chunk))
        throw new UserError('Unexpected archive stream encoding.');
      total += chunk.length;
      if (total > MAX_ARCHIVE)
        throw new UserError('Compressed Storybook build exceeds 16 MiB.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    source.destroy();
    gzip.destroy();
  }
}
