import { describe, it, expect } from 'vitest';
import { buildComment, COMMENT_MARKER } from './comment.js';
import type { RunReport, DiffResult, DiffStatus } from '../types.js';

const result = (
  storyId: string,
  status: DiffStatus,
  mismatchPercent = 0,
  error?: string,
): DiffResult => ({
  storyId,
  status,
  mismatchPixels: 0,
  mismatchPercent,
  changedRegions: [],
  error,
  durationMs: 1,
});

function report(results: DiffResult[]): RunReport {
  const summary: Record<DiffStatus, number> = {
    pass: 0,
    fail: 0,
    new: 0,
    stale: 0,
    skip: 0,
  };
  for (const r of results) summary[r.status]++;
  return {
    runId: 'r',
    branch: 'feature',
    commitSha: 'abcdef1234567890',
    capturedCount: results.length,
    totalCount: results.length,
    results,
    summary,
    durationMs: 4200,
    startedAt: '2026-01-01T00:00:00Z',
  };
}

describe('buildComment', () => {
  it('always carries the marker so the next run updates rather than duplicates', () => {
    // Without this the reporter posts a fresh comment on every push, and a
    // PR with ten pushes ends up with ten comments.
    const body = buildComment({ report: report([result('a', 'pass')]) });
    expect(body).toContain(COMMENT_MARKER);
  });

  it('leads with the verdict, not a table', () => {
    // Someone scanning a PR should learn whether they need to act without
    // parsing anything.
    const passing = buildComment({ report: report([result('a', 'pass')]) });
    expect(passing).toContain('Visual tests passed');

    const failing = buildComment({ report: report([result('a', 'fail', 1)]) });
    expect(failing).toContain('Visual changes need review');
  });

  it('names each story needing review, with its mismatch', () => {
    const body = buildComment({
      report: report([result('button--primary', 'fail', 3.721), result('b', 'pass')]),
    });
    expect(body).toContain('`button--primary`');
    expect(body).toContain('3.72%');
  });

  it('never shows 0.00% next to the word changed', () => {
    // A real change displaying as 0.00% reads as a tool bug.
    const body = buildComment({ report: report([result('a', 'fail', 0.004)]) });
    expect(body).toContain('<0.01%');
    expect(body).not.toContain('0.00%');
  });

  it('counts new and stale as needing review, not just fail', () => {
    // All three block a merge — they each need a human or agent decision.
    const body = buildComment({
      report: report([result('a', 'new'), result('b', 'stale')]),
    });
    expect(body).toContain('Visual changes need review');
    expect(body).toContain('no baseline');
    expect(body).toContain('stale baseline');
  });

  it('treats a skip-only run as passing', () => {
    // Skipped stories are excluded by choice; they are not pending work.
    const body = buildComment({
      report: report([result('a', 'pass'), result('b', 'skip')]),
    });
    expect(body).toContain('Visual tests passed');
    expect(body).toContain('1 skipped');
  });

  it('surfaces an error instead of a meaningless percentage', () => {
    const body = buildComment({
      report: report([result('a', 'fail', 0, 'viewport size changed since baseline')]),
    });
    expect(body).toContain('viewport size changed since baseline');
  });

  it('expands a short list and collapses a long one', () => {
    // A reviewer should see a handful without clicking, but twenty rows would
    // bury the rest of the PR conversation.
    const few = buildComment({ report: report([result('a', 'fail', 1)]) });
    expect(few).toContain('<details open>');

    const many = report(Array.from({ length: 20 }, (_, i) => result(`s${i}`, 'fail', 1)));
    expect(buildComment({ report: many })).toContain('<details>');
  });

  it('truncates a pathological run rather than exceeding the comment limit', () => {
    const huge = report(
      Array.from({ length: 200 }, (_, i) => result(`s${i}`, 'fail', 1)),
    );
    const body = buildComment({ report: huge });
    expect(body).toContain('and 150 more');
  });

  it('tells the reader how to accept the changes', () => {
    const body = buildComment({ report: report([result('a', 'fail', 1)]) });
    expect(body).toContain('jux approve --all');
  });

  it('does not offer an approve command when nothing needs approving', () => {
    const body = buildComment({ report: report([result('a', 'pass')]) });
    expect(body).not.toContain('jux approve');
  });

  it('footers the short sha and capture counts', () => {
    const body = buildComment({ report: report([result('a', 'pass')]) });
    expect(body).toContain('abcdef1');
    expect(body).not.toContain('abcdef1234567890');
    expect(body).toContain('1/1 captured');
  });

  it('links the artifact only when there is one', () => {
    const r = report([result('a', 'fail', 1)]);
    expect(buildComment({ report: r })).not.toContain('Images and diffs');
    expect(buildComment({ report: r, artifactUrl: 'https://x/y' })).toContain(
      '[Images and diffs](https://x/y)',
    );
  });
});
