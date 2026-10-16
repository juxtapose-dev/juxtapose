import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { expect, test } from 'vitest';
import { StorageConfigSchema } from '../config/schema.js';
import { CacheBaselineStore } from './cache-store.js';
import { committedPaths, createBaselineStore, ignoredPaths } from './create-store.js';
import { GitBaselineStore } from './git-store.js';

test('no storage key is the cache store: images are never committed by default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-create-'));
  expect(createBaselineStore(root, undefined)).toBeInstanceOf(CacheBaselineStore);
  expect(createBaselineStore(root, { kind: 'cache' })).toBeInstanceOf(CacheBaselineStore);
});

test('an explicit git or fs kind keeps the repo-backed store', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-create-'));
  expect(createBaselineStore(root, { kind: 'git' })).toBeInstanceOf(GitBaselineStore);
  expect(createBaselineStore(root, { kind: 'fs', dir: 'x' })).toBeInstanceOf(
    GitBaselineStore,
  );
});

test('commit hashes and structure, ignore images, by default', () => {
  expect(committedPaths(undefined)).toEqual([
    'juxtapose.manifest.json',
    'juxtapose.structures',
  ]);
  // One line: .juxtapose/ holds only machine-local data.
  expect(ignoredPaths(undefined)).toEqual(['.juxtapose/']);
});

test('a custom cache dir is what gets ignored', () => {
  expect(ignoredPaths({ kind: 'cache', dir: 'tmp/imgs/' })).toEqual([
    '.juxtapose/',
    'tmp/imgs/',
    'tmp/imgs.tmp/',
  ]);
});

test('the opt-in repo layout commits its image dir and ignores only runs', () => {
  expect(committedPaths({ kind: 'git' })).toEqual([
    'juxtapose.manifest.json',
    'juxtapose.structures',
    '.juxtapose/baselines',
  ]);
  expect(ignoredPaths({ kind: 'git' })).toEqual(['.juxtapose/runs/']);
});

const UNSAFE = ['a\nb', 'a\u0085b', 'a‮b', 'a b', '-rf', ''];

test.each([
  ...UNSAFE,
  '/abs',
  '..',
  'a/../b',
  'a*',
  'a[1]',
  '.',
  'juxtapose.manifest.json',
  './juxtapose.manifest.json',
  'juxtapose.structures',
  './juxtapose.structures/images',
  // Windows separators count as separators.
  '..\\x',
  'a\\..\\b',
  '\\\\server\\share',
  '\\abs',
])('cache dir %j is refused by the runtime check and the schema', (dir) => {
  expect(() => createBaselineStore('/p', { kind: 'cache', dir })).toThrow(/storage\.dir/);
  expect(Value.Check(StorageConfigSchema, { kind: 'cache', dir })).toBe(false);
});

test.each(UNSAFE)('git/fs dir %j is refused too', (dir) => {
  for (const kind of ['git', 'fs'] as const) {
    expect(() => createBaselineStore('/p', { kind, dir })).toThrow(/storage\.dir/);
    expect(Value.Check(StorageConfigSchema, { kind, dir })).toBe(false);
  }
});

// These worked before the cache store existed; "explicit git/fs unchanged"
// includes a directory outside the project.
test.each(['../shared-baselines', '/abs/baselines', 'a*', '.juxtapose/structure', '..'])(
  'git/fs dir %j still works',
  (dir) => {
    for (const kind of ['git', 'fs'] as const) {
      expect(() => createBaselineStore('/p', { kind, dir })).not.toThrow();
      expect(Value.Check(StorageConfigSchema, { kind, dir })).toBe(true);
    }
  },
);

test.each(['tmp/imgs', '.juxtapose/cache/baselines', "it's a dir"])(
  'cache dir %j is allowed',
  (dir) => {
    expect(Value.Check(StorageConfigSchema, { kind: 'cache', dir })).toBe(true);
    expect(() => createBaselineStore('/p', { kind: 'cache', dir })).not.toThrow();
  },
);

// The git/fs check must refuse exactly the characters the schema's first
// version did (C0, DEL) and the later additions, at both ends of every range,
// while accepting the neighbours just outside them. Code points, not literals:
// several of these are invisible or are line terminators.
const RANGES: Array<[string, number, number]> = [
  ['C0', 0x0000, 0x001f],
  ['DEL and C1', 0x007f, 0x009f],
  ['line separators', 0x2028, 0x2029],
  ['bidi embeddings', 0x202a, 0x202e],
  ['bidi isolates', 0x2066, 0x2069],
];

test.each(RANGES)(
  'git/fs dirs refuse the %s range at both ends and between',
  (_n, first, last) => {
    for (const cp of new Set([first, last, Math.floor((first + last) / 2)])) {
      const dir = `a${String.fromCodePoint(cp)}b`;
      for (const kind of ['git', 'fs'] as const) {
        expect(() => createBaselineStore('/p', { kind, dir })).toThrow(/storage\.dir/);
        expect(Value.Check(StorageConfigSchema, { kind, dir })).toBe(false);
      }
    }
  },
);

test.each([0x20, 0xa0, 0x2027, 0x202f, 0x2065, 0x206a, 0xe9, 0x65e5])(
  'git/fs dirs accept U+%s just outside the refused ranges',
  (cp) => {
    const dir = `a${String.fromCodePoint(cp)}b`;
    for (const kind of ['git', 'fs'] as const) {
      expect(() => createBaselineStore('/p', { kind, dir })).not.toThrow();
    }
  },
);

test('git/fs refuse a leading dash anywhere it could pass for an option', () => {
  for (const dir of ['-', '-x', '--force', '-/a']) {
    expect(() => createBaselineStore('/p', { kind: 'git', dir })).toThrow(/storage\.dir/);
  }
  expect(() => createBaselineStore('/p', { kind: 'git', dir: 'a-b' })).not.toThrow();
});
