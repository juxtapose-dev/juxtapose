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

test.each([
  'a\nb',
  'a\u0085b',
  'a\u202eb',
  'a\u2028b',
  '-rf',
  '/abs',
  '..',
  'a/../b',
  'a*',
  'a[1]',
  '.',
  '',
  '.juxtapose',
  '.juxtapose/structure',
  '.juxtapose/structure/x',
])('storage.dir %j is refused by the runtime check and the schema', (dir) => {
  expect(() => createBaselineStore('/p', { kind: 'cache', dir })).toThrow(/storage\.dir/);
  expect(() => createBaselineStore('/p', { kind: 'git', dir })).toThrow(/storage\.dir/);
  expect(Value.Check(StorageConfigSchema, { kind: 'cache', dir })).toBe(false);
});

test.each(['tmp/imgs', '.juxtapose/cache/baselines', "it's a dir"])(
  'storage.dir %j is allowed',
  (dir) => {
    expect(Value.Check(StorageConfigSchema, { kind: 'cache', dir })).toBe(true);
    expect(() => createBaselineStore('/p', { kind: 'cache', dir })).not.toThrow();
  },
);
