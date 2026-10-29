import { readFile } from 'node:fs/promises';
import type { RunReport } from '@juxtapose/core';
import type { CommonFlags } from './context.js';
import { UserError } from './user-error.js';

/** Hosted review is an explicit transfer of the merge gate, never an ignore-failures flag. */
export async function validateGitHubReview(
  flags: CommonFlags,
  commitSha: string,
): Promise<void> {
  if (
    !flags.upload ||
    flags['dry-run'] ||
    flags.story?.length ||
    flags.since ||
    flags['no-recheck'] ||
    (flags.recheck !== undefined && flags.recheck !== 'changed')
  )
    throw new UserError(
      '--review-in-github requires --upload and a full capture with --recheck changed; omit --story, --since, --dry-run and --no-recheck.',
    );
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !process.env.GITHUB_EVENT_PATH)
    throw new UserError(
      '--review-in-github requires a GitHub Actions pull_request event.',
    );
  let event: { number?: number; pull_request?: { head?: { sha?: string } } };
  try {
    event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'),
    ) as typeof event;
  } catch {
    throw new UserError('Cannot read GitHub pull_request event metadata.');
  }
  if (
    !Number.isSafeInteger(event.number) ||
    event.number! <= 0 ||
    !/^[a-f0-9]{40}$/.test(commitSha) ||
    event.pull_request?.head?.sha !== commitSha
  )
    throw new UserError(
      '--review-in-github requires checkout of the PR head SHA, not the synthetic merge commit.',
    );
}

export function assertReviewEvidence(report: RunReport): void {
  if (
    !report.results.length ||
    report.results.length !== report.totalCount ||
    report.capturedCount !== report.totalCount ||
    report.results.some(
      (r) => r.status === 'skip' || r.status === 'stale' || r.unstable || r.unrechecked,
    )
  )
    throw new UserError(
      'GitHub review requires a complete, stable capture with no skipped or stale stories. Fix capture coverage or stability and rerun.',
      1,
    );
}
