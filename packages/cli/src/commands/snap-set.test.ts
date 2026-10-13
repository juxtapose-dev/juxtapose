import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { clearPrefix, writeSnapSet } from './snap.js';

function dirWith(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jux-set-'));
  for (const f of files) writeFileSync(path.join(dir, f), '');
  return dir;
}
const SNAPS = [
  'a-home.webp',
  'a-home.structure.json.gz',
  'a-b-home.webp',
  'a-b-home.structure.json.gz',
  'other.webp',
];

test("a prefix run clears only the snaps its set file lists, not a longer prefix's", async () => {
  const dir = dirWith(SNAPS);
  await writeSnapSet(dir, 'a', ['a-home']);
  await writeSnapSet(dir, 'a-b', ['a-b-home']);
  await clearPrefix(dir, 'a');
  expect(readdirSync(dir).sort()).toEqual([
    'a-b-home.structure.json.gz',
    'a-b-home.webp',
    'a-b.set.json',
    'a.set.json',
    'other.webp',
  ]);
});

test('with no set file, the prefix glob is the fallback', async () => {
  const dir = dirWith(SNAPS);
  await clearPrefix(dir, 'a');
  expect(readdirSync(dir)).toEqual(['other.webp']);
});

test('a set file cannot reach outside its prefix', async () => {
  const dir = dirWith(SNAPS);
  writeFileSync(path.join(dir, 'a.set.json'), JSON.stringify({ names: ['other'] }));
  await clearPrefix(dir, 'a');
  expect(readdirSync(dir)).toContain('other.webp');
});
