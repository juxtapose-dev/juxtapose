import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat, rm, readdir, mkdir, writeFile } from 'node:fs/promises';
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
