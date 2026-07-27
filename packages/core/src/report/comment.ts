// Build the PR comment body.
//
// A pure function, separate from posting it, so the formatting can be tested
// without a network or a token — and so `jux run --json` consumers can render
// the same summary elsewhere.

import type { RunReport } from '../types.js';

/**
 * Invisible marker identifying our own comment.
 *
 * This is what makes the reporter update rather than accumulate: on each run
 * we list the PR's comments, find the one carrying this marker, and edit it.
 * A PR with ten pushes ends up with one comment, not ten.
 */
export const COMMENT_MARKER = '<!-- juxtapose-bot -->';

export interface CommentOptions {
  report: RunReport;
  /** Where to point someone who wants the images. Omitted when there is no
   *  artifact to link to. */
  artifactUrl?: string;
}

/** Stories that block a merge — anything a human or agent must judge. */
function blocking(report: RunReport): RunReport['results'] {
  return report.results.filter(
    (r) => r.status === 'fail' || r.status === 'new' || r.status === 'stale',
  );
}

export function buildComment({ report, artifactUrl }: CommentOptions): string {
  const s = report.summary;
  const needsReview = blocking(report);
  const lines: string[] = [COMMENT_MARKER, ''];

  // Lead with the verdict. Someone scanning a PR should not have to parse a
  // table to learn whether they need to do anything.
  if (needsReview.length === 0) {
    lines.push(`### Visual tests passed`, '');
    lines.push(`${s.pass} ${s.pass === 1 ? 'story' : 'stories'} match their baselines.`);
    if (s.skip > 0) lines.push(`${s.skip} skipped.`);
    lines.push('', footer(report, artifactUrl));
    return lines.join('\n');
  }

  lines.push(`### Visual changes need review`, '');

  lines.push('| | count |', '| --- | --- |');
  if (s.pass > 0) lines.push(`| pass | ${s.pass} |`);
  if (s.fail > 0) lines.push(`| **changed** | **${s.fail}** |`);
  if (s.new > 0) lines.push(`| **new** | **${s.new}** |`);
  if (s.stale > 0) lines.push(`| **stale** | **${s.stale}** |`);
  if (s.skip > 0) lines.push(`| skipped | ${s.skip} |`);
  lines.push('');

  // Open by default: the whole point is that a reviewer sees what changed
  // without clicking. Collapsed only when the list is long enough to bury the
  // rest of the PR conversation.
  const open = needsReview.length <= 10 ? ' open' : '';
  lines.push(
    `<details${open}>`,
    `<summary>${needsReview.length} ${needsReview.length === 1 ? 'story' : 'stories'}</summary>`,
    '',
  );

  lines.push('| story | status | changed |', '| --- | --- | --- |');
  for (const r of needsReview.slice(0, MAX_ROWS)) {
    lines.push(`| \`${r.storyId}\` | ${label(r.status)} | ${detail(r)} |`);
  }
  if (needsReview.length > MAX_ROWS) {
    lines.push(`| …and ${needsReview.length - MAX_ROWS} more | | |`);
  }
  lines.push('', '</details>', '');

  lines.push('To accept these changes:', '', '```bash', 'jux approve --all', '```', '');
  lines.push(footer(report, artifactUrl));

  return lines.join('\n');
}

/** GitHub comments have a size limit; a suite where everything changed should
 *  not produce an unpostable comment. */
const MAX_ROWS = 50;

function label(status: string): string {
  switch (status) {
    case 'fail':
      return 'changed';
    case 'new':
      return 'no baseline';
    case 'stale':
      return 'stale baseline';
    default:
      return status;
  }
}

function detail(r: RunReport['results'][number]): string {
  if (r.error) return r.error;
  if (r.status !== 'fail') return '—';
  return formatPercent(r.mismatchPercent);
}

function footer(report: RunReport, artifactUrl?: string): string {
  const parts = [
    `\`${report.commitSha.slice(0, 7)}\``,
    `${report.capturedCount}/${report.totalCount} captured`,
    `${(report.durationMs / 1000).toFixed(1)}s`,
  ];
  const meta = `<sub>juxtapose · ${parts.join(' · ')}</sub>`;
  return artifactUrl ? `${meta}\n\n<sub>[Images and diffs](${artifactUrl})</sub>` : meta;
}

/** Never show "0.00%" next to the word "changed" — it reads as a tool bug. */
function formatPercent(pct: number): string {
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  return pct > 0 ? '<0.01%' : '0%';
}
