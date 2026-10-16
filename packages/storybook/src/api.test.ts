import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startRun,
  cancelRun,
  adjacentStory,
  approvableCaptures,
  approveAllPending,
  approveEach,
  describeFailures,
  capturesFor,
  needsReview,
  imageUrl,
  isSubThreshold,
  pickCapture,
} from './api.js';
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

describe('isSubThreshold', () => {
  it('flags a hash failure whose diff marked no pixels', () => {
    expect(isSubThreshold(result('a', 'fail'))).toBe(true);
  });

  it('does not flag a failure the overlay can show, or a dimension change', () => {
    expect(
      isSubThreshold({ ...result('a', 'fail'), mismatchPixels: 9, mismatchPercent: 0.2 }),
    ).toBe(false);
    expect(isSubThreshold({ ...result('a', 'fail'), mismatchPercent: 100 })).toBe(false);
  });

  it('does not flag stories that did not fail', () => {
    expect(isSubThreshold(result('a', 'new'))).toBe(false);
    expect(isSubThreshold(undefined)).toBe(false);
  });
});

describe('variant switcher', () => {
  const v = (base: string, name: string, status: DiffStatus): DiffResult => ({
    ...result(`${base}__${name}`, status),
    baseStoryId: base,
    variant: name,
  });
  const r = report([
    v('card', 'mobile', 'new'),
    result('card', 'pass'),
    v('card', 'dark', 'fail'),
    result('cards', 'new'),
  ]);

  it("lists a story's captures, default first, then variants by name", () => {
    expect(capturesFor(r, 'card').map((c) => c.storyId)).toEqual([
      'card',
      'card__dark',
      'card__mobile',
    ]);
    // A prefix of another id is not that story.
    expect(capturesFor(r, 'cards').map((c) => c.storyId)).toEqual(['cards']);
    expect(capturesFor(null, 'card')).toEqual([]);
  });

  it('shows the chosen variant, else the default capture', () => {
    const captures = capturesFor(r, 'card');
    expect(pickCapture(captures, 'dark')?.storyId).toBe('card__dark');
    expect(pickCapture(captures, null)?.storyId).toBe('card');
    // A variant that is gone (renamed, not in this run) falls back.
    expect(pickCapture(captures, 'gone')?.storyId).toBe('card');
    // No default in the run (only a variant was recaptured): the first one.
    expect(pickCapture(captures.slice(1), null)?.storyId).toBe('card__dark');
  });

  it('"Approve all variants" takes only captures that need it and are not yet approved', () => {
    const captures = capturesFor(r, 'card');
    expect(approvableCaptures(captures, []).map((c) => c.storyId)).toEqual([
      'card__dark',
      'card__mobile',
    ]);
    expect(approvableCaptures(captures, ['card__dark']).map((c) => c.storyId)).toEqual([
      'card__mobile',
    ]);
  });
});

describe('approveEach', () => {
  it('attempts every id and reports the failures with reasons', async () => {
    const tried: string[] = [];
    const failed = await approveEach(['a', 'b', 'c'], async (id) => {
      tried.push(id);
      if (id === 'b') throw new Error('409');
    });
    expect(tried).toEqual(['a', 'b', 'c']);
    expect(failed).toEqual([{ id: 'b', reason: '409' }]);
    expect(describeFailures(failed)).toBe('b (409)');
  });
});

describe('approveAllPending', () => {
  it('carries on past a refusal and reports it instead of swallowing it', async () => {
    const msg = await approveAllPending(['a', 'b'], async (id) => {
      if (id === 'a') throw new Error("story 'a' is unstable");
    });
    expect(msg).toContain('a');
    expect(msg).toContain('unstable');
  });
  it('null when everything approves', async () => {
    expect(await approveAllPending(['a'], async () => {})).toBeNull();
  });
});

describe('action failures', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('surfaces server rejection of a run instead of reporting it started', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Invalid viewport' }), { status: 400 }),
        ),
    );
    await expect(startRun(['a'])).rejects.toThrow('Invalid viewport');
  });
  it('reports non-JSON cancel failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('proxy offline', { status: 502 })),
    );
    await expect(cancelRun()).rejects.toThrow('cancel failed: 502');
  });
  it('does not describe capture errors as subthreshold changes', () => {
    expect(isSubThreshold({ ...result('a', 'fail'), error: 'render failed' })).toBe(
      false,
    );
  });
  it('excludes confirmed unstable captures, but allows fresh confirmation of unrechecked captures', () => {
    const unstable = { ...result('a', 'fail'), unstable: { hashes: ['a', 'b'] } };
    expect(approvableCaptures([unstable], [])).toEqual([]);
    expect(approvableCaptures([{ ...unstable, unrechecked: true }], [])).toHaveLength(1);
  });
});
