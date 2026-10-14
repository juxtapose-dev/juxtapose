import { describe, it, expect } from 'vitest';
import { buildComment, COMMENT_MARKER } from './comment.js';
import type { RunReport, DiffResult, DiffStatus, ChangedRegion } from '../types.js';

const result = (
  storyId: string,
  status: DiffStatus,
  mismatchPercent = 0,
  error?: string,
  changedRegions: ChangedRegion[] = [],
): DiffResult => ({
  storyId,
  status,
  mismatchPixels: 0,
  mismatchPercent,
  changedRegions,
  viewport: { width: 1280, height: 800 },
  error,
  durationMs: 1,
});

function report(results: DiffResult[], over: Partial<RunReport> = {}): RunReport {
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
    ...over,
  };
}

describe('buildComment', () => {
  it('always carries the marker so the next run updates rather than duplicates', () => {
    // Without this the reporter posts a fresh comment on every push, and a
    // PR with ten pushes ends up with ten comments.
    const body = buildComment({ report: report([result('a', 'pass')]) });
    expect(body).toContain(COMMENT_MARKER);
  });

  it('puts the magnitude in the heading, not just the count', () => {
    // The heading is the only part that renders in the PR timeline and in
    // notification emails. Under a byte-exact hash "3 changed" is equally
    // produced by antialiasing hairs and by a collapsed layout, so the count
    // alone cannot be acted on.
    const body = buildComment({
      report: report([
        result('a', 'fail', 1.01),
        result('b', 'fail', 0.5),
        result('c', 'fail', 0.2),
      ]),
    });
    const headingLine = body.split('\n').find((l) => l.startsWith('### '));
    expect(headingLine).toContain('3 visual changes');
    expect(headingLine).toContain('largest 1.01%');
  });

  it('calls out a run that is entirely antialiasing noise', () => {
    // A wall of sub-0.1% diffs is almost always safe to approve; saying so in
    // the heading turns a scary red comment into a five-second decision.
    const body = buildComment({
      report: report([result('a', 'fail', 0.02), result('b', 'fail', 0.05)]),
    });
    expect(body.split('\n').find((l) => l.startsWith('### '))).toContain(
      'all under 0.1%',
    );
  });

  it('does not call a first run a failure', () => {
    // Every story is new by construction on a first run. Alarm language here
    // teaches people the tool cries wolf on day one.
    const body = buildComment({
      report: report([result('a', 'new'), result('b', 'new')]),
    });
    const heading = body.split('\n').find((l) => l.startsWith('### '));
    expect(heading).toContain('2 new stories');
    expect(heading).toContain('no baselines yet');
    expect(heading).not.toContain('need review');
  });

  it('leads with capture failures, which are not visual decisions', () => {
    const body = buildComment({
      report: report([
        result('a', 'fail', 40),
        result('b', 'fail', 0, 'browser crashed'),
      ]),
    });
    expect(body.split('\n').find((l) => l.startsWith('### '))).toContain(
      'failed to capture',
    );
  });

  it('sorts errors first, then by magnitude descending', () => {
    // A crashed capture records 0% and a dimension mismatch records 100%, so
    // sorting on the number alone scatters the two error kinds to opposite
    // ends of the table. Only `error` is a reliable marker.
    const body = buildComment({
      report: report([
        result('small', 'fail', 0.5),
        result('big', 'fail', 12),
        result('crashed', 'fail', 0, 'capture produced no snapshot'),
      ]),
    });
    const order = ['crashed', 'big', 'small'].map((id) => body.indexOf(`\`${id}\``));
    expect(order).toEqual([...order].sort((a, b) => a - b));
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
      report: report([result('a', 'fail', 1), result('b', 'new'), result('c', 'stale')]),
    });
    expect(body).toContain('need review');
    expect(body).toContain('`b`');
    expect(body).toContain('`c`');
  });

  it('says stale pixels are identical rather than leaving the cell empty', () => {
    // resolveStatus only reaches `stale` after the hash matches, so this is a
    // guarantee. It is also the cheapest row on the list to clear, and saying
    // so stops it reading like unexplained work.
    const body = buildComment({
      report: report([result('a', 'fail', 1), result('b', 'stale')]),
    });
    expect(body).toContain('pixels identical');
  });

  it('drops the status column when every row shares a status', () => {
    // A column of identical strings carries no information, and fail-only is
    // the modal run.
    const body = buildComment({
      report: report([result('a', 'fail', 1), result('b', 'fail', 2)]),
    });
    expect(body).toContain('| story | changed |');
    expect(body).not.toContain('| story | status | changed |');
  });

  it('keeps the status column when the run is mixed', () => {
    const body = buildComment({
      report: report([result('a', 'fail', 1), result('b', 'new')]),
    });
    expect(body).toContain('| story | status | changed |');
  });

  it('drops the mismatch column when nothing was compared', () => {
    // On a first run there is no baseline to diff against, so a "changed"
    // column would be dead weight on every single row.
    const body = buildComment({
      report: report([result('a', 'new'), result('b', 'new')]),
    });
    expect(body).toContain('| story |');
    expect(body).not.toContain('changed |');
  });

  it('says where the change is, not just how much', () => {
    // 1% in one region is a text tweak; 1% across six is a token that moved
    // everything. The percentage alone cannot tell them apart.
    const body = buildComment({
      report: report([
        result('a', 'fail', 1, undefined, [
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 600, y: 400, width: 200, height: 100 },
        ]),
      ]),
    });
    expect(body).toContain('2 regions');
    expect(body).toContain('middle-center');
  });

  it('locates the largest region, not whichever was discovered first', () => {
    // computeChangedRegions returns row-scan discovery order, so the first
    // entry is the topmost — not the one that matters.
    const body = buildComment({
      report: report([
        result('a', 'fail', 1, undefined, [
          { x: 0, y: 0, width: 4, height: 4 },
          { x: 1000, y: 700, width: 200, height: 80 },
        ]),
      ]),
    });
    expect(body).toContain('bottom-right');
  });

  it('treats a skip-only run as passing', () => {
    // Skipped stories are excluded by choice; they are not pending work.
    const body = buildComment({
      report: report([result('a', 'pass'), result('b', 'skip')]),
    });
    expect(body).toContain('Visual tests passed');
    expect(body).toContain('1 skipped');
  });

  it('says how many were skipped by the config on a failing run too', () => {
    const skipped = { ...result('c', 'skip'), skippedBy: ['c--*'] };
    const body = buildComment({
      report: report([result('a', 'fail', 2), result('b', 'pass'), skipped]),
    });
    expect(body).toContain("1 skipped by the project config's `stories`");
  });

  it('surfaces an error instead of a meaningless percentage', () => {
    const body = buildComment({
      report: report([result('a', 'fail', 0, 'viewport size changed since baseline')]),
    });
    expect(body).toContain('viewport size changed since baseline');
  });

  it('truncates a pathological run rather than exceeding the comment limit', () => {
    const huge = report(
      Array.from({ length: 200 }, (_, i) => result(`s${i}`, 'fail', 1)),
    );
    const body = buildComment({ report: huge });
    expect(body).toContain('and 170 more');
  });

  it('does not claim the omitted rows were the smallest when they were not', () => {
    // Fails sort by magnitude, but new/stale sort after them by storyId. A tail
    // of new stories was cut alphabetically and has no magnitude at all, so
    // "smallest changes omitted" would misdescribe what the reader is missing.
    const mixed = report([
      ...Array.from({ length: 20 }, (_, i) => result(`f${i}`, 'fail', i + 1)),
      ...Array.from({ length: 15 }, (_, i) => result(`n${i}`, 'new')),
    ]);
    const body = buildComment({ report: mixed });
    expect(body).toContain('and 5 more');
    expect(body).not.toContain('smallest changes omitted');
  });

  it('keeps the smallest-omitted note when the tail really is all changes', () => {
    const fails = report(
      Array.from({ length: 40 }, (_, i) => result(`s${i}`, 'fail', i + 1)),
    );
    expect(buildComment({ report: fails })).toContain('smallest changes omitted');
  });

  it('drops the trailing note rather than wrapping on a long story id', () => {
    // Storybook ids routinely run past the alignment column; padding past it
    // wraps the line inside GitHub's fixed-width block, which is worse than
    // having no annotation at all.
    const long = 'design-system-forms-text-field--with-a-long-validation-error';
    const body = buildComment({ report: report([result(long, 'fail', 5)]) });
    expect(body).toContain(`jux handoff ${long}\n`);
    expect(body).not.toContain(`${long} #`);
  });

  it('tells the reader to capture before approving', () => {
    // `jux approve` reads the LAST LOCAL RUN. The run being reported happened
    // on a CI runner, so approve-without-run either fails outright or silently
    // approves a stale local run — the worst outcome available.
    const body = buildComment({ report: report([result('a', 'fail', 1)]) });
    const fence = body.slice(
      body.indexOf('```bash'),
      body.indexOf('```', body.indexOf('```bash') + 3),
    );
    expect(fence).toContain('jux run');
    expect(fence.indexOf('jux run')).toBeLessThan(fence.indexOf('jux approve'));
  });

  it('offers the agent handoff on a changed story', () => {
    const body = buildComment({ report: report([result('card--wide', 'fail', 1)]) });
    expect(body).toContain('jux handoff card--wide');
  });

  it('does not send the reader investigating antialiasing noise', () => {
    // Under 0.1% is sub-pixel territory. Pointing the "what moved here?" tool
    // at it wastes the one action the comment is asking for.
    const body = buildComment({ report: report([result('a', 'fail', 0.02)]) });
    expect(body).not.toContain('jux handoff');
  });

  it('never suggests approving a story that failed to capture', () => {
    // Approving a crashed capture bakes a broken baseline into the manifest —
    // worse than the red build it replaces.
    const body = buildComment({
      report: report([
        result('crashed', 'fail', 0, 'capture produced no snapshot'),
        result('real', 'fail', 2),
      ]),
    });
    expect(body).toContain('--story real');
    expect(body).not.toContain('--story crashed');
  });

  it('leaves no empty cells in a mixed table', () => {
    // An empty cell reads as a rendering bug. Every status has something true
    // to say about itself.
    const body = buildComment({
      report: report([result('a', 'fail', 1), result('b', 'new'), result('c', 'stale')]),
    });
    const rows = body.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).not.toMatch(/\|\s*\|/);
  });

  it('keeps the commands out of the collapsed section', () => {
    // The first-time reader is exactly who needs the CTA; hiding it behind a
    // click costs them the discovery. The prose is what gets collapsed.
    const body = buildComment({ report: report([result('a', 'fail', 1)]) });
    expect(body.indexOf('```bash')).toBeLessThan(body.indexOf('<details>'));
  });

  it('does not offer an approve command when nothing needs approving', () => {
    const body = buildComment({ report: report([result('a', 'pass')]) });
    expect(body).not.toContain('jux approve');
  });

  it('only explains the statuses actually present', () => {
    // A fail-only run should not lecture the reader about what stale means.
    const body = buildComment({ report: report([result('a', 'fail', 1)]) });
    expect(body).not.toContain('byte-identical');
  });

  it('escapes pipes so a hostile id cannot corrupt the table', () => {
    // Story ids come from the platform and errors come from thrown exceptions.
    // An unescaped pipe turns the table into gibberish.
    const body = buildComment({
      report: report([result('a|b', 'fail', 0, 'boom | bang')]),
    });
    expect(body).toContain('a\\|b');
    expect(body).toContain('boom \\| bang');
  });

  it('footers the short sha and capture counts', () => {
    const body = buildComment({ report: report([result('a', 'pass')]) });
    expect(body).toContain('abcdef1');
    expect(body).not.toContain('abcdef1234567890');
    expect(body).toContain('1/1 captured');
  });

  it('explains a narrowed capture instead of leaving a bare ratio', () => {
    // "6 of 42" reads as something going wrong unless it says why not all
    // stories were captured.
    const body = buildComment({
      report: report([result('a', 'pass')], { capturedCount: 6, totalCount: 42 }),
    });
    expect(body).toContain('6 of 42 captured (change analysis)');
  });

  it('does not claim every story matched when only some were captured', () => {
    const body = buildComment({
      report: report([result('a', 'pass')], { capturedCount: 1, totalCount: 42 }),
    });
    expect(body).toContain('captured story matches');
  });

  it('links the artifact only when there is one', () => {
    // A link to an empty artifacts list spends the reader's click and their
    // trust, so callers pass this only when a report was actually written.
    const r = report([result('a', 'fail', 1)]);
    expect(buildComment({ report: r })).not.toContain('artifacts');
    expect(buildComment({ report: r, artifactUrl: 'https://x/y' })).toContain(
      '[CI run — report.html is in the artifacts](https://x/y)',
    );
  });
});

describe('sub-threshold changes', () => {
  it('does not print 0% for a hash failure the pixel diff could not mark', () => {
    // #2563eb -> #1d4ed8 fails the hash but sits inside pixelmatch's tolerance.
    const body = buildComment({ report: report([result('button--large', 'fail')]) });
    expect(body).toContain('**subtle**, diff marks no pixels');
    expect(body).not.toContain('**0%**');
  });

  it('still reports a crashed capture as its error, not as subtle', () => {
    const body = buildComment({
      report: report([result('a', 'fail', 0, 'capture timed out')]),
    });
    expect(body).not.toContain('subtle');
  });
});

describe('buildComment with variants', () => {
  const v = (base: string, name: string, status: DiffStatus, pct = 0): DiffResult => ({
    ...result(`${base}__${name}`, status, pct),
    baseStoryId: base,
    variant: name,
  });

  it('labels a variant row `story · variant` and counts captures', () => {
    const body = buildComment({
      report: report([
        result('card', 'pass'),
        v('card', 'dark', 'fail', 3),
        v('card', 'mobile', 'new'),
      ]),
    });
    expect(body).toContain('`card · dark`');
    expect(body).toContain('`card · mobile`');
    expect(body).toMatch(/### 2 captures need review/);
    // The command still takes the key, quoted where a shell needs it.
    expect(body).toContain('jux handoff card__dark');
  });

  it('a passing run says how many stories the captures cover', () => {
    const body = buildComment({
      report: report([result('a', 'pass'), v('a', 'dark', 'pass'), result('b', 'pass')]),
    });
    expect(body).toContain('3 captures match their baselines, across 2 stories.');
  });

  it('without variants, reads exactly as before', () => {
    const body = buildComment({
      report: report([result('a', 'pass'), result('b', 'pass')]),
    });
    expect(body).toContain('2 stories match their baselines.');
  });
});

describe('baseline image unavailable', () => {
  const unavailable = (): DiffResult => ({
    ...result('a--b', 'fail'),
    baselineImage: 'unavailable',
  });

  it('says structure diff only instead of a percentage, and still triages', () => {
    const body = buildComment({ report: report([unavailable()]) });
    expect(body).toContain(
      'baseline image not available (not in cache); structure diff only',
    );
    expect(body).not.toContain('0%');
    expect(body).not.toContain('subtle');
  });

  it('the heading does not call an unmeasured change "under 0.1%"', () => {
    const body = buildComment({ report: report([unavailable(), unavailable()]) });
    expect(body).toContain('structure diff only');
    expect(body).not.toContain('under 0.1%');
    const mixed = buildComment({
      report: report([unavailable(), result('b', 'fail', 3.2)]),
    });
    expect(mixed).toContain('largest 3.20%');
  });

  it('tells reviewers to commit the manifest and structure, never images', () => {
    const body = buildComment({ report: report([unavailable()]) });
    expect(body).toContain('.juxtapose/structure/');
    expect(body).not.toContain('.juxtapose/baselines/');
  });
});
