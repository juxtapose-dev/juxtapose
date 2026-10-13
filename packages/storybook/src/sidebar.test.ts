import { describe, it, expect, vi } from 'vitest';
import {
  applyStatuses,
  decoratedIds,
  statusUpdate,
  toSidebarStatus,
  worstCapture,
} from './sidebar.js';
import type { RunReport, DiffResult, DiffStatus } from '@juxtapose/core';

const result = (
  storyId: string,
  status: DiffStatus,
  mismatchPercent = 0,
): DiffResult => ({
  storyId,
  status,
  mismatchPixels: 0,
  mismatchPercent,
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

describe('toSidebarStatus', () => {
  it('maps pass to success', () => {
    expect(toSidebarStatus('pass', 0)?.status).toBe('success');
  });

  it('maps fail to error, with the percentage in the tooltip', () => {
    const s = toSidebarStatus('fail', 3.721);
    expect(s?.status).toBe('error');
    expect(s?.description).toBe('3.72% changed');
  });

  it('shows a floor rather than a misleading 0.00% for tiny diffs', () => {
    // "0.00% changed" next to a red dot reads as a tool bug.
    expect(toSidebarStatus('fail', 0.004)?.description).toBe('<0.01% changed');
  });

  it('treats new and stale as warnings, not errors', () => {
    // Neither means the component is wrong: one has nothing to compare
    // against, the other may be pixel-identical but on an untrusted baseline.
    expect(toSidebarStatus('new', 0)?.status).toBe('warn');
    expect(toSidebarStatus('stale', 0)?.status).toBe('warn');
  });

  it('gives skipped stories no dot at all', () => {
    // A dot would imply we know something about how it looks. We don't.
    expect(toSidebarStatus('skip', 0)).toBeNull();
  });
});

describe('statusUpdate', () => {
  it('is empty when there is no report', () => {
    expect(statusUpdate(null, [], [])).toEqual({});
  });

  it('decorates every story in the report', () => {
    const u = statusUpdate(report([result('a', 'pass'), result('b', 'fail', 1)]), [], []);
    expect(u['a']?.status).toBe('success');
    expect(u['b']?.status).toBe('error');
  });

  it('clears stories that dropped out of the run', () => {
    // The gotcha this whole function exists for: Storybook MERGES status
    // updates, so omitting an id keeps its old dot. A story that was failing
    // and then got filtered out, renamed or deleted would stay red forever —
    // asserting something false about current state.
    const u = statusUpdate(report([result('a', 'pass')]), [], ['a', 'gone']);
    expect(u['a']).not.toBeNull();
    expect(u).toHaveProperty('gone');
    expect(u['gone']).toBeNull();
  });

  it('does not clear ids it never set', () => {
    const u = statusUpdate(report([result('a', 'pass')]), [], []);
    expect(Object.keys(u)).toEqual(['a']);
  });

  it('shows a story approved since the run as passing', () => {
    // Otherwise approving appears to do nothing until the next full run.
    const u = statusUpdate(report([result('a', 'fail', 5)]), ['a'], []);
    expect(u['a']?.status).toBe('success');
  });
});

describe('decoratedIds', () => {
  it('returns only ids carrying a status, not the cleared ones', () => {
    const ids = decoratedIds({
      a: { status: 'success', title: 't', description: 'd' },
      b: null,
    });
    expect(ids).toEqual(['a']);
  });
});

describe('applyStatuses', () => {
  it('uses the experimental API when present', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const ok = await applyStatuses({ experimental_updateStatus: fn }, { a: null });
    expect(ok).toBe(true);
    expect(fn).toHaveBeenCalledWith('juxtapose', { a: null });
  });

  it('falls back to an unprefixed name', async () => {
    // The prefix has come and gone across majors; probe both.
    const fn = vi.fn().mockResolvedValue(undefined);
    expect(await applyStatuses({ updateStatus: fn }, {})).toBe(true);
  });

  it('warns rather than throwing when no status API exists', async () => {
    // Losing the dots is cosmetic. Throwing here would take down the manager
    // and with it the panel, which is the part that matters.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await applyStatuses({}, {})).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('survives the API throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValue(new Error('nope'));
    expect(await applyStatuses({ experimental_updateStatus: fn }, {})).toBe(false);
    warn.mockRestore();
  });
});

describe('variant rollup', () => {
  const variant = (
    base: string,
    name: string,
    status: DiffStatus,
    pct = 0,
  ): DiffResult => ({
    ...result(`${base}__${name}`, status, pct),
    baseStoryId: base,
    variant: name,
  });

  it.each<[DiffStatus[], DiffStatus | undefined]>([
    [['pass', 'fail', 'new'], 'fail'],
    [['pass', 'stale', 'new'], 'new'],
    [['pass', 'stale'], 'stale'],
    [['pass', 'skip'], 'pass'],
    [['skip', 'skip'], undefined],
  ])('worst of %j is %s', (statuses, want) => {
    expect(worstCapture(statuses.map((status) => ({ status })))?.status).toBe(want);
  });

  it('keys one dot per story, the worst across its captures, naming the variant', () => {
    const u = statusUpdate(
      report([
        result('a', 'pass'),
        variant('a', 'dark', 'fail', 2),
        variant('a', 'mobile', 'new'),
      ]),
      [],
      [],
    );
    expect(Object.keys(u)).toEqual(['a']);
    expect(u['a']).toMatchObject({ status: 'error', description: 'dark: 2.00% changed' });
  });

  it('an approved variant stops deciding the dot', () => {
    const u = statusUpdate(
      report([result('a', 'pass'), variant('a', 'dark', 'fail', 2)]),
      ['a__dark'],
      [],
    );
    expect(u['a']).toMatchObject({ status: 'success' });
  });

  it('a default failure keeps its plain description', () => {
    const u = statusUpdate(
      report([result('a', 'fail', 1), variant('a', 'dark', 'new')]),
      [],
      [],
    );
    expect(u['a']).toMatchObject({ status: 'error', description: '1.00% changed' });
  });
});
