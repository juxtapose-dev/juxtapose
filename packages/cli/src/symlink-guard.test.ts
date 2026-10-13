import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { diffCommand } from './commands/diff.js';
import { snapCommand } from './commands/snap.js';
import { firstSymlink } from './symlink-guard.js';

// sharp is core's dependency, not the CLI's: resolve it from where core lives.
const coreRequire = createRequire(
  createRequire(import.meta.url).resolve('@juxtapose/core'),
);
const sharp = coreRequire('sharp') as typeof import('sharp');
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));

test('firstSymlink names the first symlinked segment, and none when clean', async () => {
  const root = tmp('jux-guard-');
  const outside = tmp('jux-out-');
  expect(await firstSymlink(root, ['.juxtapose', 'crops', 'x'])).toBeUndefined();
  mkdirSync(path.join(root, '.juxtapose'));
  symlinkSync(outside, path.join(root, '.juxtapose', 'crops'));
  expect(await firstSymlink(root, ['.juxtapose', 'crops', 'x'])).toBe(
    path.join(root, '.juxtapose', 'crops'),
  );
});

async function png(color: number): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: color, g: 0, b: 0 } },
  })
    .webp({ lossless: true })
    .toBuffer();
}

/** Capture stderr so a refusal's message can be asserted. */
async function quiet<T>(f: () => Promise<T>): Promise<{ r: T; err: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let err = '';
  process.stderr.write = ((s: string) => (
    (err += s),
    true
  )) as typeof process.stderr.write;
  try {
    return { r: await f(), err };
  } finally {
    process.stderr.write = write;
  }
}

test('--crops refuses to write through a symlinked crops dir', async () => {
  const root = tmp('jux-proj-');
  const outside = tmp('jux-out-');
  mkdirSync(path.join(outside, 'a~vs~b'));
  writeFileSync(path.join(outside, 'a~vs~b', 'keep.txt'), 'mine');
  mkdirSync(path.join(root, '.juxtapose', 'snaps'), { recursive: true });
  writeFileSync(path.join(root, '.juxtapose/snaps/a.webp'), await png(0));
  writeFileSync(path.join(root, '.juxtapose/snaps/b.webp'), await png(200));
  symlinkSync(outside, path.join(root, '.juxtapose', 'crops'));
  const { r, err } = await quiet(() =>
    diffCommand('a', 'b', { project: root, crops: true }),
  );
  expect(r).toBe(3);
  expect(err).toContain('jux: refusing to write through symlink');
  expect(readdirSync(outside)).toEqual(['a~vs~b']);
  expect(readdirSync(path.join(outside, 'a~vs~b'))).toEqual(['keep.txt']);
});

test('--crops refuses when .juxtapose itself is a symlink', async () => {
  const root = tmp('jux-proj-');
  const outside = tmp('jux-out-');
  mkdirSync(path.join(outside, 'snaps'), { recursive: true });
  writeFileSync(path.join(outside, 'snaps/a.webp'), await png(0));
  writeFileSync(path.join(outside, 'snaps/b.webp'), await png(200));
  symlinkSync(outside, path.join(root, '.juxtapose'));
  const { r } = await quiet(() => diffCommand('a', 'b', { project: root, crops: true }));
  expect(r).toBe(3);
  expect(readdirSync(outside)).toEqual(['snaps']);
});

test('snap --as-prefix refuses through a symlinked snaps dir, before any browser', async () => {
  const root = tmp('jux-proj-');
  const outside = tmp('jux-out-');
  writeFileSync(path.join(outside, 'p-home.webp'), 'precious');
  mkdirSync(path.join(root, '.juxtapose'));
  symlinkSync(outside, path.join(root, '.juxtapose', 'snaps'));
  const { r, err } = await quiet(() =>
    snapCommand(['http://localhost:1/'], { project: root, 'as-prefix': 'p' }),
  );
  expect(r).toBe(3);
  expect(err).toContain('refusing to write through symlink');
  expect(readdirSync(outside)).toEqual(['p-home.webp']);
});
