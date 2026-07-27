import { describe, it, expect } from 'vitest';
import { adjacentStory, needsReview, imageUrl } from './api.js';
import type { RunReport, DiffResult, DiffStatus } from '@juxtapose/core';

const result = (storyId: string, status: DiffStatus): DiffResult => ({
  storyId,
  status,
  mismatchPixels: 0,
  mismatchPercent: 0,
  changedRegions: [],
  durationMs: 1,
});

const report = (results: DiffResult[]): RunReport => ({
  runId: 'r',
  branch: 'main',
  commitSha: 'abc',
  capturedCount: results.length,
  totalCount: results.length,
  results,
  summary: { pass: 0, fail: 0, new: 0, stale: 0, skip: 0 },
  durationMs: 1,
  startedAt: '2026-01-01T00:00:00Z',
});

describe('needsReview', () => {
  it('is empty without a report', () => {
    expect(needsReview(null, [])).toEqual([]);
  });

  it('ignores passing and skipped stories', () => {
    const r = report([
      result('a', 'pass'),
      result('b', 'fail'),
      result('c', 'skip'),
      result('d', 'new'),
    ]);
    expect(needsReview(r, []).map((x) => x.storyId)).toEqual(['b', 'd']);
  });

  it('drops stories approved since the run', () => {
    // Approving shouldn't require a re-run before the story leaves the queue.
    const r = report([result('a', 'fail'), result('b', 'fail')]);
    expect(needsReview(r, ['a']).map((x) => x.storyId)).toEqual(['b']);
  });
});

describe('adjacentStory', () => {
  const three = report([result('a', 'fail'), result('b', 'fail'), result('c', 'fail')]);

  it('returns null when nothing needs review', () => {
    expect(adjacentStory(report([result('a', 'pass')]), [], 'a', 'next')).toBeNull();
  });

  it('jumps to the first pending story from somewhere unrelated', () => {
    // Viewing a passing story and pressing "next" should land on work to do.
    expect(adjacentStory(three, [], 'passing-story', 'next')).toBe('a');
  });

  it('moves forward and backward', () => {
    expect(adjacentStory(three, [], 'a', 'next')).toBe('b');
    expect(adjacentStory(three, [], 'b', 'prev')).toBe('a');
  });

  it('wraps around in both directions', () => {
    expect(adjacentStory(three, [], 'c', 'next')).toBe('a');
    expect(adjacentStory(three, [], 'a', 'prev')).toBe('c');
  });

  it('returns null when the current story is the only one left', () => {
    // Otherwise "next" would appear to do nothing, or worse, jump to itself
    // and look like a broken shortcut.
    const one = report([result('a', 'fail'), result('b', 'pass')]);
    expect(adjacentStory(one, [], 'a', 'next')).toBeNull();
  });

  it('skips stories approved since the run', () => {
    expect(adjacentStory(three, ['b'], 'a', 'next')).toBe('c');
  });
});

describe('imageUrl', () => {
  it('encodes the story id and carries a cache-buster', () => {
    const url = imageUrl('diff', 'group/a--b', 7);
    expect(url).toContain(encodeURIComponent('group/a--b'));
    expect(url).toContain('v=7');
    expect(url).not.toContain('group/a--b?');
  });
});
