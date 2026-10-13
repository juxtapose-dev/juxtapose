import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { writeSnap, writeSnapSet } from './snap.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      '../../../core/src/diff/__fixtures__/structural-corpus.json',
    ),
    'utf8',
  ),
);

function planted(names: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jux-snaps-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'jux-out-'));
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    writeFileSync(path.join(outside, n), 'precious');
    symlinkSync(path.join(outside, n), path.join(dir, n));
  }
  return { dir, outside };
}
const page = (structure?: unknown) =>
  ({
    url: 'http://x/',
    snapshot: {
      image: Buffer.from('new image'),
      structure,
      viewport: { width: 1, height: 1 },
      durationMs: 1,
    },
  }) as never;

test('a symlinked snap image is replaced, never written through', async () => {
  const { dir, outside } = planted(['before.webp']);
  await writeSnap(dir, 'before', page(), {} as never);
  expect(readFileSync(path.join(outside, 'before.webp'), 'utf8')).toBe('precious');
  expect(lstatSync(path.join(dir, 'before.webp')).isFile()).toBe(true);
  expect(readFileSync(path.join(dir, 'before.webp'), 'utf8')).toBe('new image');
});

test('a symlinked sidecar is replaced, never written through', async () => {
  const { dir, outside } = planted(['before.structure.json.gz']);
  await writeSnap(dir, 'before', page(fixture.cases.noop.structure), {} as never);
  expect(readFileSync(path.join(outside, 'before.structure.json.gz'), 'utf8')).toBe(
    'precious',
  );
  expect(lstatSync(path.join(dir, 'before.structure.json.gz')).isFile()).toBe(true);
});

test('a symlinked set file is replaced, never written through', async () => {
  const { dir, outside } = planted(['p.set.json']);
  await writeSnapSet(dir, 'p', ['p-a']);
  expect(readFileSync(path.join(outside, 'p.set.json'), 'utf8')).toBe('precious');
  expect(lstatSync(path.join(dir, 'p.set.json')).isFile()).toBe(true);
});
