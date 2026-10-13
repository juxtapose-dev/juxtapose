import { describe, it, expect } from 'vitest';
import {
  mkdtemp,
  readFile,
  stat,
  rm,
  readdir,
  mkdir,
  writeFile,
  symlink,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readZip, extractZip, installZip } from './zip.js';
import { buildZip } from './__tests__/zip-builder.js';

const zip = buildZip([
  { name: 'shell-x/', data: Buffer.alloc(0), mode: 0o755 },
  {
    name: 'shell-x/chrome-headless-shell',
    data: Buffer.from('#!/bin/sh\necho hi\n'),
    mode: 0o755,
  },
  { name: 'shell-x/ABOUT', data: Buffer.from('about'), mode: 0o644, stored: true },
  { name: 'shell-x/big.pak', data: Buffer.alloc(300_000, 7), mode: 0o644 },
]);

const file = (name: string) => buildZip([{ name, data: Buffer.from('a'), mode: 0o644 }]);

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jux-zip-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('readZip', () => {
  it('reads deflated and stored entries with their modes', () => {
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'shell-x/',
      'shell-x/chrome-headless-shell',
      'shell-x/ABOUT',
      'shell-x/big.pak',
    ]);
    expect(entries[1].data.toString()).toBe('#!/bin/sh\necho hi\n');
    expect(entries[1].mode & 0o777).toBe(0o755);
    expect(entries[2].data.toString()).toBe('about');
    expect(entries[3].data.length).toBe(300_000);
    expect(entries[0].isDirectory).toBe(true);
  });
  it('rejects a bad crc', () => {
    // Flip a byte inside the STORED entry's data: inflate is not involved, so
    // the only check that can catch it is the crc.
    const broken = Buffer.from(zip);
    broken[broken.indexOf(Buffer.from('about'))] ^= 0xff;
    expect(() => readZip(broken)).toThrow(/crc mismatch for shell-x\/ABOUT/);
  });
  it('refuses an entry whose declared size exceeds the cap', () => {
    const big = buildZip([
      { name: 'a', data: Buffer.from('x'), mode: 0o644, claimedSize: 5000 },
    ]);
    expect(() => readZip(big, { maxEntryBytes: 1000 })).toThrow(/too large/);
  });
  it('refuses a deflate bomb that lies about its size', () => {
    const bomb = buildZip([{ name: 'a', data: Buffer.alloc(100_000, 0), mode: 0o644 }]);
    // Declared size is fine for the header check only if we also bound inflate.
    expect(() => readZip(bomb, { maxEntryBytes: 1000 })).toThrow(/too large/);
  });
  it('refuses when the total exceeds the cap', () => {
    const two = buildZip([
      { name: 'a', data: Buffer.alloc(600), mode: 0o644 },
      { name: 'b', data: Buffer.alloc(600), mode: 0o644 },
    ]);
    expect(() => readZip(two, { maxEntryBytes: 1000, maxTotalBytes: 1000 })).toThrow(
      /total/,
    );
  });
});

describe('readZip hardening', () => {
  const eocdAt = (b: Buffer) => b.length - 22;
  it('throws corrupt archive for a truncated archive', () => {
    expect(() => readZip(zip.subarray(0, zip.length - 10))).toThrow(/corrupt archive/);
    expect(() => readZip(zip.subarray(0, 40))).toThrow(/corrupt archive/);
  });
  it('throws corrupt archive for a central directory offset past the end', () => {
    const bad = Buffer.from(zip);
    bad.writeUInt32LE(99999, eocdAt(bad) + 16);
    expect(() => readZip(bad)).toThrow(/corrupt archive/);
  });
  it('throws corrupt archive when the comment length disagrees with the file', () => {
    const bad = Buffer.concat([zip, Buffer.from('trailing')]);
    expect(() => readZip(bad)).toThrow(/corrupt archive/);
  });
  it('throws corrupt archive for a name length that runs off the buffer', () => {
    const bad = Buffer.from(zip);
    const cd = bad.readUInt32LE(eocdAt(bad) + 16);
    bad.writeUInt16LE(60000, cd + 28);
    expect(() => readZip(bad)).toThrow(/corrupt archive/);
  });
  it('throws corrupt archive for a local header offset past the end', () => {
    const bad = Buffer.from(zip);
    const cd = bad.readUInt32LE(eocdAt(bad) + 16);
    bad.writeUInt32LE(zip.length - 5, cd + 42);
    expect(() => readZip(bad)).toThrow(/corrupt archive/);
  });
  it('throws corrupt archive when the compressed size runs off the buffer', () => {
    const bad = Buffer.from(zip);
    const cd = bad.readUInt32LE(eocdAt(bad) + 16);
    bad.writeUInt32LE(0x7fffffff, cd + 20);
    expect(() => readZip(bad)).toThrow(/corrupt archive/);
  });
  it('refuses encrypted entries', () => {
    const enc = buildZip([{ name: 'a', data: Buffer.from('a'), mode: 0o644, flags: 1 }]);
    expect(() => readZip(enc)).toThrow(/zip: encrypted entry a/);
  });
  it('refuses unsupported compression methods cleanly', () => {
    const z = buildZip([
      { name: 'a', data: Buffer.from('a'), mode: 0o644, stored: true, method: 12 },
    ]);
    expect(() => readZip(z)).toThrow(/unsupported compression method 12/);
  });
  it('reads a data-descriptor (bit 3) entry', () => {
    const z = buildZip([
      { name: 'a', data: Buffer.from('hello'), mode: 0o644, flags: 8 },
      { name: 'b', data: Buffer.from('world'), mode: 0o644, flags: 8, stored: true },
    ]);
    expect(readZip(z).map((e) => e.data.toString())).toEqual(['hello', 'world']);
  });
});

describe('extractZip', () => {
  it('writes files with exec bits and returns their paths', async () => {
    await withDir(async (dir) => {
      const written = await extractZip(zip, dir);
      expect(written).toContain(path.join(dir, 'shell-x/chrome-headless-shell'));
      if (process.platform !== 'win32') {
        expect(
          (await stat(path.join(dir, 'shell-x/chrome-headless-shell'))).mode & 0o111,
        ).not.toBe(0);
        expect((await stat(path.join(dir, 'shell-x/ABOUT'))).mode & 0o111).toBe(0);
      }
      expect(await readFile(path.join(dir, 'shell-x/ABOUT'), 'utf8')).toBe('about');
    });
  });
  it('refuses ".." traversal', async () => {
    await withDir(async (dir) => {
      await expect(extractZip(file('../x'), dir)).rejects.toThrow(/\.\./);
      await expect(extractZip(file('a/../../x'), dir)).rejects.toThrow(/\.\./);
    });
  });
  it('refuses absolute names and drive letters', async () => {
    await withDir(async (dir) => {
      await expect(extractZip(file('/etc/x'), dir)).rejects.toThrow(/absolute/);
      await expect(extractZip(file('C:/x'), dir)).rejects.toThrow(/absolute/);
      await expect(extractZip(file('C:x'), dir)).rejects.toThrow(/absolute/);
    });
  });
  it('refuses backslashes', async () => {
    await withDir(async (dir) => {
      await expect(extractZip(file('..\\x'), dir)).rejects.toThrow(/backslash/);
      await expect(extractZip(file('\\x'), dir)).rejects.toThrow(/backslash/);
      await expect(extractZip(file('a\\b'), dir)).rejects.toThrow(/backslash/);
    });
  });
  it('refuses symlink entries', async () => {
    await withDir(async (dir) => {
      await expect(
        extractZip(
          buildZip([
            { name: 'l', data: Buffer.from('target'), mode: 0o777, symlink: true },
          ]),
          dir,
        ),
      ).rejects.toThrow(/symlink/);
    });
  });
  it('refuses an oversized entry before writing anything', async () => {
    await withDir(async (dir) => {
      const big = buildZip([{ name: 'a', data: Buffer.alloc(5000), mode: 0o644 }]);
      await expect(extractZip(big, dir, { maxEntryBytes: 1000 })).rejects.toThrow(
        /too large/,
      );
      expect(await readdir(dir)).toEqual([]);
    });
  });
  it('refuses a NUL byte in a name', async () => {
    await withDir(async (dir) => {
      await expect(extractZip(file('a\0b'), dir)).rejects.toThrow(/NUL/);
      expect(await readdir(dir)).toEqual([]);
    });
  });
  it('refuses names that resolve to the root', async () => {
    await withDir(async (dir) => {
      for (const n of ['.', './', 'a/..', 'a/../']) {
        await expect(extractZip(file(n), dir)).rejects.toThrow(/root|\.\./);
      }
    });
  });
  it('refuses duplicate names', async () => {
    await withDir(async (dir) => {
      const two = (a: string, b: string) =>
        buildZip([
          { name: a, data: Buffer.from('1'), mode: 0o644 },
          { name: b, data: Buffer.from('2'), mode: 0o644 },
        ]);
      await expect(extractZip(two('a', 'a'), dir)).rejects.toThrow(/duplicate/);
      await expect(extractZip(two('a', './a'), dir)).rejects.toThrow(/duplicate/);
      expect(await readdir(dir)).toEqual([]);
    });
  });
  it('refuses file/dir collisions in either order', async () => {
    await withDir(async (dir) => {
      const mk = (...names: string[]) =>
        buildZip(names.map((name) => ({ name, data: Buffer.alloc(0), mode: 0o644 })));
      await expect(extractZip(mk('a', 'a/b'), dir)).rejects.toThrow(/collision/);
      await expect(extractZip(mk('a/b', 'a'), dir)).rejects.toThrow(/collision/);
      await expect(extractZip(mk('a/', 'a'), dir)).rejects.toThrow(/collision|duplicate/);
      await expect(extractZip(mk('a', 'a/'), dir)).rejects.toThrow(/collision|duplicate/);
      expect(await readdir(dir)).toEqual([]);
    });
  });
  it('allows a dir entry after files inside it', async () => {
    await withDir(async (dir) => {
      const z = buildZip([
        { name: 'a/b', data: Buffer.from('x'), mode: 0o644 },
        { name: 'a/', data: Buffer.alloc(0), mode: 0o755 },
      ]);
      await extractZip(z, dir);
      expect(await readFile(path.join(dir, 'a/b'), 'utf8')).toBe('x');
    });
  });
  it('validates every entry before writing any', async () => {
    await withDir(async (dir) => {
      const bad = buildZip([
        { name: 'ok', data: Buffer.from('a'), mode: 0o644 },
        { name: '../x', data: Buffer.from('a'), mode: 0o644 },
      ]);
      await expect(extractZip(bad, dir)).rejects.toThrow(/\.\./);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});

describe('installZip', () => {
  it('extracts into place and leaves no temp dir behind', async () => {
    await withDir(async (dir) => {
      const final = path.join(dir, 'chrome', '151');
      await installZip(zip, final);
      expect(await readFile(path.join(final, 'shell-x/ABOUT'), 'utf8')).toBe('about');
      expect(await readdir(path.join(dir, 'chrome'))).toEqual(['151']);
    });
  });
  it('a failed extraction leaves nothing at the final path or beside it', async () => {
    await withDir(async (dir) => {
      const final = path.join(dir, 'chrome', '151');
      const bad = buildZip([
        { name: 'ok', data: Buffer.from('a'), mode: 0o644 },
        { name: '../x', data: Buffer.from('a'), mode: 0o644 },
      ]);
      await expect(installZip(bad, final)).rejects.toThrow(/\.\./);
      expect(await readdir(path.join(dir, 'chrome'))).toEqual([]);
    });
  });
  it('writes the marker inside the dir before it appears', async () => {
    await withDir(async (dir) => {
      const final = path.join(dir, 'chrome', '151');
      await installZip(zip, final, { marker: '.complete' });
      expect((await stat(path.join(final, '.complete'))).isFile()).toBe(true);
    });
  });
  it('survives three concurrent installs to one target', async () => {
    await withDir(async (dir) => {
      const final = path.join(dir, 'chrome', '151');
      const marker = '.complete';
      const results = await Promise.allSettled([
        installZip(zip, final, { marker }),
        installZip(zip, final, { marker }),
        installZip(zip, final, { marker }),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
      expect(await readdir(path.join(dir, 'chrome'))).toEqual(['151']);
      expect((await readdir(final)).sort()).toEqual(['.complete', 'shell-x']);
      expect(await readFile(path.join(final, 'shell-x/ABOUT'), 'utf8')).toBe('about');
    });
  });
  it('replaces a symlinked finalDir instead of following it', async () => {
    if (process.platform === 'win32') return;
    await withDir(async (dir) => {
      const elsewhere = path.join(dir, 'elsewhere');
      await mkdir(elsewhere);
      await writeFile(path.join(elsewhere, 'keep'), 'k');
      const final = path.join(dir, 'chrome', '151');
      await mkdir(path.dirname(final), { recursive: true });
      await symlink(elsewhere, final);
      await installZip(zip, final);
      expect((await lstat(final)).isSymbolicLink()).toBe(false);
      expect(await readdir(elsewhere)).toEqual(['keep']);
      expect(await readdir(final)).toEqual(['shell-x']);
      expect(await readdir(path.dirname(final))).toEqual(['151']);
    });
  });
  it('replaces a file at finalDir', async () => {
    await withDir(async (dir) => {
      const final = path.join(dir, 'chrome', '151');
      await mkdir(path.dirname(final), { recursive: true });
      await writeFile(final, 'x');
      await installZip(zip, final);
      expect(await readdir(final)).toEqual(['shell-x']);
      expect(await readdir(path.dirname(final))).toEqual(['151']);
    });
  });
  it('replaces an existing partial install', async () => {
    await withDir(async (dir) => {
      const final = path.join(dir, 'chrome', '151');
      await mkdir(final, { recursive: true });
      await writeFile(path.join(final, 'stale'), 'x');
      await installZip(zip, final);
      expect(await readdir(final)).toEqual(['shell-x']);
    });
  });
});
