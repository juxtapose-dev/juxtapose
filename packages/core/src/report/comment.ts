// Build the PR comment body.
//
// A pure function, separate from posting it, so the formatting can be tested
// without a network or a token — and so `jux run --json` consumers can render
// the same summary elsewhere.
//
// The comment is a triage surface, not a report. Two constraints shape it:
//
// 1. The `###` heading is the only part that renders in the PR timeline
//    collapse and in GitHub notification emails — tables do not. For a large
//    share of readers the heading IS the comment, so the decisive number
//    (largest mismatch) goes there rather than in row one of a table.
// 2. Images are impossible. GitHub's sanitizer strips `src` from both
//    `<img src="data:...">` and `![](data:...)`; only https:// survives, via
//    camo. So the text has to carry everything and link out for pixels.

import type { DiffResult, RunReport, Viewport } from '../types.js';
import {
  captureLabel,
  countStories,
  formatPercent,
  hasVariants,
  isSubThreshold,
} from './format.js';
import { shellQuote } from '../shell-quote.js';

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
   *  artifact to link to — a link to an empty artifacts list is worse than no
   *  link, so callers pass this only when they actually wrote a report. */
  artifactUrl?: string;
}

/** GitHub comments have a size limit, but attention is the binding constraint
 *  long before bytes are: nobody triages row 34 in a PR comment. */
const MAX_ROWS = 30;

/** Stories that block a merge — anything a human or agent must judge. */
function blocking(report: RunReport): DiffResult[] {
  return report.results.filter(
    (r) => r.status === 'fail' || r.status === 'new' || r.status === 'stale',
  );
}

/** A story whose pixels differ. An errored capture is marked 'fail' too, but it
 *  is not a visual decision — nothing about it can be reviewed or approved. */
const changed = (r: DiffResult) => r.status === 'fail' && !r.error;

export function buildComment({ report, artifactUrl }: CommentOptions): string {
  const needsReview = blocking(report);
  const lines: string[] = [COMMENT_MARKER, ''];

  if (needsReview.length === 0) {
    lines.push(`### Visual tests passed`, '', passingBody(report));
    lines.push('', footer(report, artifactUrl));
    return lines.join('\n');
  }

  const rows = triageOrder(needsReview);

  lines.push(`### ${heading(rows)}`, '');

  // A first run has nothing to compare against, and the table alone does not
  // say so — every other shape is self-explanatory from the heading.
  if (rows.every((r) => r.status === 'new')) {
    lines.push(
      'Nothing to compare against: these stories have never been approved. ' +
        'Check the captures look right, then approve to establish them as baselines.',
      '',
    );
  }

  lines.push(...table(rows));
  lines.push('');

  // A story the config skipped is not in the table; say so here too, or a
  // failing run reads as though everything was captured.
  const byConfig = report.results.filter((r) => r.skippedBy?.length).length;
  if (byConfig > 0) {
    lines.push(`${byConfig} skipped by the project config's \`stories\`.`, '');
  }

  // Uncollapsed, and one fence. The comment is edited in place, so GitHub does
  // not re-notify on a push — the repeat reader only sees this when they come
  // back to act on it. The first-time reader is the one who would otherwise pay
  // a click to discover the tool even has a CTA.
  lines.push('```bash', ...commands(rows), '```', '');

  lines.push(...guidance(rows));
  lines.push(footer(report, artifactUrl));

  return lines.join('\n');
}

/**
 * Order by triage cost, not by magnitude alone.
 *
 * Errors lead: a capture that crashed is not a visual decision, and it cannot
 * be ranked by percentage anyway — a crash records 0% (run.ts) while a
 * dimension mismatch records 100% (diff.ts), so sorting on the number would
 * scatter the two error kinds to opposite ends. `error != null` is the only
 * reliable marker.
 *
 * Then fail by magnitude descending, then new, then stale — stale last because
 * its pixels are byte-identical and it is the cheapest thing on the list to
 * clear. Ties break on storyId so the body is stable across re-runs; an
 * unstable order would show up as a phantom edit on every push.
 */
function triageOrder(results: DiffResult[]): DiffResult[] {
  const rank = (r: DiffResult) => {
    if (r.error) return 0;
    if (r.status === 'fail') return 1;
    if (r.status === 'new') return 2;
    return 3;
  };
  return [...results].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (rank(a) === 1) {
      const byPct = b.mismatchPercent - a.mismatchPercent;
      if (byPct !== 0) return byPct;
    }
    return a.storyId.localeCompare(b.storyId);
  });
}

/**
 * The heading carries the verdict AND its magnitude.
 *
 * Under a byte-exact hash, "3 changed" is produced equally by three
 * antialiasing hairs and three collapsed layouts. The count alone cannot be
 * acted on; the largest mismatch can.
 */
function heading(rows: DiffResult[]): string {
  // Rows are captures. With variants among them, "story" would miscount.
  const [one, many] = hasVariants(rows) ? ['capture', 'captures'] : ['story', 'stories'];
  const errors = rows.filter((r) => r.error).length;
  const fails = rows.filter(changed);

  if (errors > 0) {
    const rest = rows.length - errors;
    const tail =
      rest > 0 ? ` — ${rest} more ${rest === 1 ? 'needs' : 'need'} review` : '';
    return `${count(errors, one, many)} failed to capture${tail}`;
  }

  // Derived from `rows`, not `report.summary`: summary.fail counts errored
  // stories too (run.ts marks them 'fail'), so a summary-based check here would
  // silently depend on the errors branch above catching them first.
  //
  // A first run is 100% new by construction. Calling that a failure teaches
  // people the tool cries wolf on day one.
  if (rows.every((r) => r.status === 'new')) {
    return `${count(rows.length, `new ${one}`, `new ${many}`)} — no baselines yet`;
  }

  if (rows.every((r) => r.status === 'stale')) {
    return `${count(rows.length, 'stale baseline', 'stale baselines')} — pixels identical, re-approve to re-anchor`;
  }

  if (fails.length === 0) {
    return `${count(rows.length, one, many)} need review`;
  }

  const largest = Math.max(...fails.map((r) => r.mismatchPercent));
  // Below 0.1% the individual numbers are noise and a wall of them reads as
  // alarming; saying so once is more useful than quoting the largest hair.
  // `formatPercent` never renders "0.00%", which would read as a tool bug.
  const magnitude =
    largest < 0.1 ? 'all under 0.1%' : `largest ${formatPercent(largest)}`;

  // Mixed: name the shape, since "5 changes" would overstate what changed.
  if (rows.length > fails.length) {
    return `${count(rows.length, one, many)} need review — ${fails.length} changed, ${magnitude}`;
  }

  const noun = count(fails.length, 'visual change', 'visual changes');
  const verb = fails.length === 1 ? 'needs' : 'need';
  const detail =
    fails.length === 1 && largest >= 0.1 ? formatPercent(largest) : magnitude;
  return `${noun} ${verb} review — ${detail}`;
}

/**
 * Drop columns that carry no information.
 *
 * When every row shares a status the column is a stack of identical strings,
 * and when nothing was compared there is no mismatch to show. Both are the
 * common case: a fail-only run and a first run.
 */
function table(rows: DiffResult[]): string[] {
  const statuses = new Set(rows.map((r) => r.status));
  const showStatus = statuses.size > 1;
  // Nothing to say about magnitude when nothing was compared — an all-new run
  // would otherwise carry a column reading "first capture" on every row.
  const showDetail = rows.some(
    (r) => r.error || r.status === 'fail' || r.status === 'stale',
  );

  const head = [
    'story',
    showStatus ? 'status' : null,
    showDetail ? 'changed' : null,
  ].filter((c): c is string => c !== null);

  const out = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];

  for (const r of rows.slice(0, MAX_ROWS)) {
    const cells = [
      `\`${cell(captureLabel(r))}\``,
      showStatus ? (r.status === 'fail' ? 'changed' : r.status) : null,
      showDetail ? detail(r) : null,
    ].filter((c): c is string => c !== null);
    out.push(`| ${cells.join(' | ')} |`);
  }

  if (rows.length > MAX_ROWS) {
    const omitted = rows.slice(MAX_ROWS);
    // "smallest changes" is only true when the tail is all fails — they sort by
    // magnitude. `new` and `stale` sort after them by storyId, so a mixed tail
    // is cut alphabetically and has no magnitude to be smallest of.
    const why = omitted.every(changed) ? ', smallest changes omitted' : '';
    // A plain line, not a table row: a row would need its cell count to track
    // the columns above, and renders as trailing empty cells.
    out.push('', `_…and ${omitted.length} more${why}._`);
  }

  return out;
}

/**
 * One copyable sequence.
 *
 * `jux run` leads because approval reads the LAST LOCAL RUN — the run being
 * reported here happened on a CI runner, so `jux approve` alone either fails
 * with "no run found" or silently approves a stale local run. Keeping it in the
 * same fence is deliberate: a reader who copies a later block must not end up
 * with approve-without-run.
 */
function commands(rows: DiffResult[]): string[] {
  const out = [annotate('jux run', 'approval reads a local run, so capture first')];

  // Only worth investigating a change big enough to be something. Below 0.1%
  // is antialiasing territory (see magnitudeHint in agent/handoff.ts), and
  // pointing the "investigate this" tool at noise wastes the reader's time.
  const worthInvestigating = rows.find((r) => changed(r) && r.mismatchPercent >= 0.1);
  if (worthInvestigating) {
    out.push(
      annotate(
        `jux handoff ${shellQuote(worthInvestigating.storyId)}`,
        'unsure? agent-ready prompt: what moved, where',
      ),
    );
  }

  // Never name an errored story here: approving a crashed capture bakes a
  // broken baseline into the manifest, which is the one outcome worse than a
  // red build.
  const approvable = rows.find((r) => !r.error);
  out.push(
    approvable
      ? annotate('jux approve --all', `or --story ${shellQuote(approvable.storyId)}`)
      : 'jux approve --all',
  );
  return out;
}

/**
 * Align a trailing `#` comment, or drop it.
 *
 * Story ids are long — the examples already hit 31 characters and a real design
 * system goes well past that. Padding past the column produces a line that
 * wraps inside GitHub's fixed-width code block, which is worse than having no
 * annotation at all.
 */
function annotate(command: string, note: string): string {
  return command.length > COMMENT_COLUMN
    ? command
    : `${command.padEnd(COMMENT_COLUMN)} # ${note}`;
}

const COMMENT_COLUMN = 32;

/**
 * Reference material, collapsed.
 *
 * A first-timer reads this once; a repeat reader has internalized it. Only the
 * statuses actually present get a paragraph — a fail-only run should not
 * explain what "stale" means.
 */
function guidance(rows: DiffResult[]): string[] {
  const has = (s: DiffResult['status']) => rows.some((r) => r.status === s && !r.error);
  const paras: string[] = [];

  if (rows.some((r) => r.error)) {
    paras.push(
      'Some stories failed to capture. That is not a visual decision — approving ' +
        'one would bake a broken baseline into the manifest. Fix the capture first.',
    );
  }
  if (has('fail')) {
    paras.push(
      'Pixels differ from the approved baseline. Decide intentional vs regression ' +
        'before approving.',
    );
  }
  if (has('new')) {
    paras.push(
      'New stories have no baseline, so nothing was compared. Confirm the render is ' +
        'correct, then approve to establish it.',
    );
  }
  if (has('stale')) {
    paras.push(
      'Stale baselines render **byte-identical** pixels — there is nothing to look at. ' +
        'The baseline was approved on a commit that is not in this history, usually a ' +
        'branch that never merged. Re-approving re-anchors it.',
    );
  }

  paras.push(
    'Then commit `juxtapose.manifest.json` and `.juxtapose/baselines/` — that is what ' +
      'makes approval a reviewable diff.',
  );
  paras.push(
    'Prefer a UI? Start the run from the **Visual** panel in Storybook to approve, ' +
      'diff, and copy agent prompts without leaving the browser.',
  );

  return [
    '<details><summary>What these mean, and what to commit</summary>',
    '',
    ...paras.flatMap((p) => [p, '']),
    '</details>',
    '',
  ];
}

/** "2 skipped." or "3 skipped, 2 by the project config's `stories`." */
function skippedText(report: RunReport): string {
  const byConfig = report.results.filter((r) => r.skippedBy?.length).length;
  return byConfig > 0
    ? `${report.summary.skip} skipped, ${byConfig} by the project config's \`stories\`.`
    : `${report.summary.skip} skipped.`;
}

function passingBody(report: RunReport): string {
  const s = report.summary;
  // `pass` counts CAPTURED passes, so "42 stories match" is a lie on a narrowed
  // run where only six were captured.
  const narrowed = report.capturedCount < report.totalCount;
  if (hasVariants(report.results)) {
    const stories = countStories(report.results);
    const across = `across ${count(stories, 'story', 'stories')}`;
    const head = narrowed
      ? `${count(s.pass, 'capture taken matches', 'captures taken match')} their baselines, ${across}.`
      : `${count(s.pass, 'capture matches', 'captures match')} their baselines, ${across}.`;
    return s.skip > 0 ? `${head} ${skippedText(report)}` : head;
  }
  const head = narrowed
    ? `${count(s.pass, 'captured story matches', 'captured stories match')} their baselines.`
    : `${count(s.pass, 'story matches', 'stories match')} their baselines.`;
  return s.skip > 0 ? `${head} ${skippedText(report)}` : head;
}

/**
 * Say something true for every status — an em-dash column is dead weight, and
 * on a first run it is dead weight on every single row.
 */
function detail(r: DiffResult): string {
  if (r.error) return cell(r.error);
  // Blank only when the whole table is new stories and the column is dropped
  // entirely; alongside other statuses it needs to say why it is not a number.
  if (r.status === 'new') return 'first capture';
  // Reachable only after a byte-exact hash match (baseline/status.ts), so this
  // is a guarantee rather than a guess.
  if (r.status === 'stale') return 'pixels identical';
  // A sub-tolerance colour change has no percentage worth printing: "0%" in
  // a table of changes reads as "nothing changed".
  const parts = [
    isSubThreshold(r)
      ? '**subtle**, diff marks no pixels'
      : `**${formatPercent(r.mismatchPercent)}**`,
  ];
  const where = regionHint(r);
  if (where) parts.push(where);
  return parts.join(' · ');
}

/**
 * How localized the change is — percentage alone cannot tell a text tweak from
 * a token that moved everything. One region at top-left is a button; six
 * scattered regions is a font or a design token.
 *
 * `computeChangedRegions` returns row-scan discovery order, NOT size order, so
 * the largest has to be picked explicitly.
 */
function regionHint(r: DiffResult): string | null {
  if (!r.viewport || r.changedRegions.length === 0) return null;
  const n = r.changedRegions.length;
  const largest = r.changedRegions.reduce((a, b) =>
    b.width * b.height > a.width * a.height ? b : a,
  );
  const v: Viewport = r.viewport;
  const cx = largest.x + largest.width / 2;
  const cy = largest.y + largest.height / 2;
  const vertical =
    cy < v.height / 3 ? 'top' : cy > (v.height * 2) / 3 ? 'bottom' : 'middle';
  const horizontal =
    cx < v.width / 3 ? 'left' : cx > (v.width * 2) / 3 ? 'right' : 'center';
  return `${n} ${n === 1 ? 'region' : 'regions'}, ${vertical}-${horizontal}`;
}

function footer(report: RunReport, artifactUrl?: string): string {
  // A narrowed capture count reads as alarming without a reason; naming the
  // mechanism rules out "the tool gave up and skipped things".
  const captured =
    report.capturedCount < report.totalCount
      ? `${report.capturedCount} of ${report.totalCount} captured (change analysis)`
      : `${report.capturedCount}/${report.totalCount} captured`;

  const parts = [
    `\`${report.commitSha.slice(0, 7)}\``,
    captured,
    `${(report.durationMs / 1000).toFixed(1)}s`,
  ];
  const meta = `<sub>juxtapose · ${parts.join(' · ')}</sub>`;
  // Describes the destination, not the content: it resolves to a run page with
  // a zip, which is a true statement even if the upload step was skipped.
  return artifactUrl
    ? `${meta}\n\n<sub>[CI run — report.html is in the artifacts](${artifactUrl})</sub>`
    : meta;
}

/**
 * A pipe in a cell silently corrupts the table into gibberish. Story ids come
 * from the platform and error strings come from thrown exceptions — neither is
 * ours to trust.
 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
