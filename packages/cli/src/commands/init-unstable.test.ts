import { expect, test } from 'vitest';
import type { DiffResult } from '@juxtapose/core';
import { partitionForInit } from './init.js';

const r = (storyId: string, extra: Partial<DiffResult> = {}): DiffResult => ({
  storyId,
  status: 'new',
  mismatchPixels: 0,
  mismatchPercent: 0,
  changedRegions: [],
  durationMs: 1,
  ...extra,
});

test('init refuses unstable and unconfirmed results and keeps the rest', () => {
  const results = [
    r('ok'),
    r('rand', { unstable: { hashes: ['a', 'b'] } }),
    r('slow', { unstable: { hashes: ['a'], unconfirmed: 'timed out' } }),
    r('skipped', { status: 'skip' }),
    r('boom', { status: 'fail' }),
  ];
  const { approvable, refused } = partitionForInit(results, false);
  expect(approvable.map((x) => x.storyId)).toEqual(['ok']);
  expect(refused.map((x) => x.storyId)).toEqual(['rand', 'slow']);
});

test('--allow-unstable lets init baseline them', () => {
  const results = [r('ok'), r('rand', { unstable: { hashes: ['a', 'b'] } })];
  const { approvable, refused } = partitionForInit(results, true);
  expect(approvable.map((x) => x.storyId)).toEqual(['ok', 'rand']);
  expect(refused).toEqual([]);
});
