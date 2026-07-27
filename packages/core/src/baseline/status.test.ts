import { describe, it, expect } from 'vitest';
import { hashImage, resolveStatus, toDiffStatus } from './status.js';
import { encodeStoryId } from './git-store.js';
import type { BaselineManifest } from '../types.js';

const img = (s: string) => Buffer.from(s);

function manifestWith(storyId: string, image: Buffer, commit = 'a'.repeat(40)): BaselineManifest {
  return {
    version: 1,
    baselines: {
      [storyId]: {
        hash: hashImage(image),
        commit,
        approvedBy: 'test',
        approvedAt: '2026-01-01T00:00:00Z',
      },
    },
  };
}

describe('resolveStatus', () => {
  it('is new when the manifest has no entry', () => {
    expect(resolveStatus('x', img('a'), { version: 1, baselines: {} })).toBe('new');
  });

  it('passes on a byte-exact match', () => {
    const image = img('same');
    expect(resolveStatus('x', image, manifestWith('x', image))).toBe('pass');
  });

  it('fails on any byte difference', () => {
    // The whole design: one byte is a failure, there is no threshold.
    expect(resolveStatus('x', img('b'), manifestWith('x', img('a')))).toBe('changed');
  });

  it('is stale when the baseline commit is not an ancestor of HEAD', () => {
    const image = img('same');
    const status = resolveStatus('x', image, manifestWith('x', image), {
      isAncestor: () => false,
    });
    expect(status).toBe('stale');
  });

  it('prefers changed over stale when bytes differ', () => {
    // A changed story on an unmerged branch should report the actionable
    // status, not the bookkeeping one.
    const status = resolveStatus('x', img('b'), manifestWith('x', img('a')), {
      isAncestor: () => false,
    });
    expect(status).toBe('changed');
  });
});

describe('toDiffStatus', () => {
  it('maps every baseline status', () => {
    expect(toDiffStatus('pass')).toBe('pass');
    expect(toDiffStatus('changed')).toBe('fail');
    expect(toDiffStatus('stale')).toBe('stale');
    expect(toDiffStatus('new')).toBe('new');
  });
});

describe('encodeStoryId', () => {
  it('leaves ordinary ids alone', () => {
    expect(encodeStoryId('components-button--primary')).toBe('components-button--primary');
  });

  it('encodes path separators so ids cannot escape the baseline dir', () => {
    expect(encodeStoryId('a/b')).not.toContain('/');
    expect(encodeStoryId('../../etc/passwd')).not.toContain('/');
    expect(encodeStoryId('../../etc/passwd')).not.toContain('..');
  });

  it('is stable and collision-free for ids differing only in encoded chars', () => {
    expect(encodeStoryId('a/b')).not.toBe(encodeStoryId('a:b'));
  });
});
