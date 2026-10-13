import { describe, it, expect } from 'vitest';
import { buildHtmlReport } from './html.js';
import type { RunReport, DiffResult, DiffStatus } from '../types.js';

const png = (label: string) => Buffer.from(label);

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

const withImages = (storyId: string) =>
  new Map([[storyId, { baseline: png('b'), current: png('c'), diff: png('d') }]]);

describe('buildHtmlReport', () => {
  it('is a complete standalone document', () => {
    const html = buildHtmlReport({
      report: report([result('a', 'pass')]),
      images: new Map(),
    });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
  });

  it('references nothing external, so it works from file://', () => {
    // The whole point of the format. A stylesheet link or a sibling images/
    // directory breaks the moment someone downloads the artifact and opens it.
    const html = buildHtmlReport({
      report: report([result('a', 'fail', 1)]),
      images: withImages('a'),
    });
    const externals = html.match(/(?:src|href)="(?!data:)[^"]*"/g) ?? [];
    expect(externals).toEqual([]);
  });

  it('inlines images as data URIs', () => {
    const html = buildHtmlReport({
      report: report([result('a', 'fail', 1)]),
      images: withImages('a'),
    });
    expect(html).toContain('data:image/webp;base64,');
  });

  it('leads with the verdict', () => {
    const passing = buildHtmlReport({
      report: report([result('a', 'pass')]),
      images: new Map(),
    });
    expect(passing).toContain('Visual tests passed');

    const failing = buildHtmlReport({
      report: report([result('a', 'fail', 1)]),
      images: withImages('a'),
    });
    expect(failing).toContain('Visual changes need review');
  });

  it('only renders stories needing review', () => {
    // A passing story has nothing to show and would just be scroll.
    const html = buildHtmlReport({
      report: report([result('shown', 'fail', 1), result('hidden', 'pass')]),
      images: withImages('shown'),
    });
    expect(html).toContain('shown');
    expect(html).not.toContain('>hidden<');
  });

  it('shows a single capture when there is no baseline to compare', () => {
    // A new story has nothing on the other side; an empty half would read as
    // a broken report rather than an absent baseline.
    const html = buildHtmlReport({
      report: report([result('a', 'new')]),
      images: new Map([['a', { current: png('c') }]]),
    });
    expect(html).toContain('class="single"');
    expect(html).not.toContain('data-mode="slider"');
  });

  it('omits the diff tab when there is no diff image', () => {
    const html = buildHtmlReport({
      report: report([result('a', 'fail', 1)]),
      images: new Map([['a', { baseline: png('b'), current: png('c') }]]),
    });
    expect(html).toContain('data-mode="slider"');
    expect(html).not.toContain('data-mode="diff"');
  });

  it('never shows 0.00% next to the word changed', () => {
    const html = buildHtmlReport({
      report: report([result('a', 'fail', 0.004)]),
      images: withImages('a'),
    });
    expect(html).toContain('&lt;0.01%');
  });

  it('surfaces an error on the story it belongs to', () => {
    const html = buildHtmlReport({
      report: report([result('a', 'fail', 0, 'viewport size changed since baseline')]),
      images: withImages('a'),
    });
    expect(html).toContain('viewport size changed since baseline');
  });

  it('escapes story ids rather than trusting them', () => {
    // Ids come from the platform. An id containing markup must not be able to
    // inject into the report.
    const html = buildHtmlReport({
      report: report([result('<img onerror=alert(1)>', 'fail', 1)]),
      images: withImages('<img onerror=alert(1)>'),
    });
    expect(html).not.toContain('<img onerror=');
    expect(html).toContain('&lt;img onerror=');
  });

  it('carries the run metadata a reviewer needs', () => {
    const html = buildHtmlReport({
      report: report([result('a', 'pass')]),
      images: new Map(),
    });
    expect(html).toContain('feature');
    expect(html).toContain('abcdef1');
    expect(html).toContain('1/1 captured');
  });
});

describe('sub-threshold changes', () => {
  it('says the diff marked nothing instead of "0% changed"', () => {
    const html = buildHtmlReport({
      report: report([result('a', 'fail')]),
      images: withImages('a'),
    });
    expect(html).toContain('subtle change, diff marks no pixels');
    expect(html).not.toContain('0% changed');
  });
});
