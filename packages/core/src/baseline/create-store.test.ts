import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
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
  expect(ignoredPaths(undefined)).toEqual(['.juxtapose/cache/', '.juxtapose/runs/']);
});

test('a custom cache dir is what gets ignored', () => {
  expect(ignoredPaths({ kind: 'cache', dir: 'tmp/imgs/' })).toEqual([
    'tmp/imgs/',
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
