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
    '.juxtapose/structure',
  ]);
  expect(ignoredPaths(undefined)).toEqual([
    '.juxtapose/cache/',
    '.juxtapose/baselines/*.webp',
    '.juxtapose/runs/',
  ]);
});

test('a custom cache dir is what gets ignored', () => {
  expect(ignoredPaths({ kind: 'cache', dir: 'tmp/imgs/' })).toEqual([
    'tmp/imgs/',
    '.juxtapose/baselines/*.webp',
    '.juxtapose/runs/',
  ]);
});

test('the opt-in repo layout commits its image dir and ignores only runs', () => {
  expect(committedPaths({ kind: 'git' })).toEqual([
    'juxtapose.manifest.json',
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
  '.juxtapose',
  '.juxtapose/structure',
  '.juxtapose/structure/x',
  // Windows separators count as separators.
  '..\\x',
  'a\\..\\b',
  '.juxtapose\\structure',
  '.juxtapose\\structure\\x',
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
