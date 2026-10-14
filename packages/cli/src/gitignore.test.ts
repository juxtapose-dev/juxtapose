import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ensureIgnored } from './gitignore.js';

const entries = ['.juxtapose/cache/', '.juxtapose/runs/'];

async function project(initial?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-ignore-'));
  if (initial !== undefined) await writeFile(path.join(root, '.gitignore'), initial);
  return root;
}
const read = (root: string) => readFile(path.join(root, '.gitignore'), 'utf8');

test('creates .gitignore when there is none', async () => {
  const root = await project();
  expect(await ensureIgnored(root, entries)).toEqual(entries);
  const text = await read(root);
  for (const e of entries) expect(text).toContain(`${e}\n`);
});

test('is idempotent: a second call changes nothing', async () => {
  const root = await project('node_modules/\n');
  await ensureIgnored(root, entries);
  const once = await read(root);
  expect(await ensureIgnored(root, entries)).toEqual([]);
  expect(await read(root)).toBe(once);
});

test('preserves existing content and adds a missing trailing newline', async () => {
  const root = await project('node_modules/\ndist');
  await ensureIgnored(root, entries);
  const text = await read(root);
  expect(text.startsWith('node_modules/\ndist\n')).toBe(true);
});

test('adds only what is missing, and counts equivalent spellings as present', async () => {
  const root = await project('/.juxtapose/runs\n.juxtapose/cache\n');
  expect(await ensureIgnored(root, entries)).toEqual([]);
  expect(await read(root)).toBe('/.juxtapose/runs\n.juxtapose/cache\n');
});

test('does not treat a commented-out line as present', async () => {
  const root = await project('# .juxtapose/runs/\n');
  expect(await ensureIgnored(root, entries)).toEqual(entries);
});
