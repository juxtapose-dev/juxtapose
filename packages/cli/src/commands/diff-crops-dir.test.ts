import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { cropDirName, diffCommand } from './diff.js';

const coreRequire = createRequire(
  createRequire(import.meta.url).resolve('@juxtapose/core'),
);
const sharp = coreRequire('sharp') as typeof import('sharp');

async function png(color: number): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: color, g: 0, b: 0 } },
  })
    .webp({ lossless: true })
    .toBuffer();
}

test('same-named images in different dirs get different crops dirs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-crops-'));
  const img = async (run: string, color: number) => {
    const d = path.join(root, run, 'images');
    mkdirSync(d, { recursive: true });
    const f = path.join(d, 'X-current.webp');
    writeFileSync(f, await png(color));
    return f;
  };
  const [a, b, c] = [
    await img('runA', 0),
    await img('runB', 120),
    await img('runC', 240),
  ];
  const run = async (x: string, y: string) => {
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      return await diffCommand(x, y, { project: root, crops: true, json: true });
    } finally {
      process.stdout.write = w;
    }
  };
  expect(await run(a, b)).toBe(1);
  expect(await run(a, c)).toBe(1);
  const dirs = readdirSync(path.join(root, '.juxtapose', 'crops')).filter(
    (n) => n !== '.gitignore',
  );
  expect(dirs).toHaveLength(2);
  expect(dirs).toContain(cropDirName(a, b));
  expect(dirs).toContain(cropDirName(a, c));
  for (const d of dirs) {
    expect(readdirSync(path.join(root, '.juxtapose', 'crops', d))).toContain(
      'crop-1.png',
    );
  }
});

test('path inputs are hashed by absolute path; snap names stay readable', () => {
  expect(cropDirName('before', 'after')).toBe('before~vs~after');
  expect(cropDirName('/a/x.webp', '/b/x.webp')).not.toBe(
    cropDirName('/c/x.webp', '/b/x.webp'),
  );
  expect(cropDirName('/a/x.webp', '/b/x.webp')).toMatch(
    /^x\.[0-9a-f]{8}~vs~x\.[0-9a-f]{8}$/,
  );
  expect(cropDirName('/a/x.webp', 'x')).not.toBe(cropDirName('x', 'x'));
});
