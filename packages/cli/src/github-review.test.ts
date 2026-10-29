import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { validateGitHubReview, assertReviewEvidence } from './github-review.js';
import type { RunReport } from '@juxtapose/core';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const sha = 'a'.repeat(40);
async function event(head = sha) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jux-github-'));
  dirs.push(dir);
  const file = path.join(dir, 'event.json');
  await writeFile(
    file,
    JSON.stringify({ number: 3, pull_request: { head: { sha: head } } }),
  );
  vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
  vi.stubEnv('GITHUB_EVENT_PATH', file);
}
test('review mode requires upload, complete selection, and matching PR head', async () => {
  await event();
  await expect(validateGitHubReview({ upload: true }, sha)).resolves.toBeUndefined();
  for (const flags of [
    {},
    { upload: true, story: ['A'] },
    { upload: true, since: 'main' },
    { upload: true, 'dry-run': true },
    { upload: true, 'no-recheck': true },
    { upload: true, recheck: 'off' },
  ])
    await expect(validateGitHubReview(flags, sha)).rejects.toThrow();
  await expect(validateGitHubReview({ upload: true }, 'b'.repeat(40))).rejects.toThrow(
    /head/,
  );
  vi.stubEnv('GITHUB_EVENT_NAME', 'push');
  await expect(validateGitHubReview({ upload: true }, sha)).rejects.toThrow(
    /pull_request/,
  );
});
test('incomplete, skipped, unstable and stale evidence cannot hand off a green capture job', () => {
  const report = {
    totalCount: 1,
    capturedCount: 1,
    results: [{ storyId: 'A', status: 'fail', hash: sha }],
  } as RunReport;
  expect(() => assertReviewEvidence(report)).not.toThrow();
  for (const patch of [
    { results: [] },
    { capturedCount: 0 },
    { results: [{ status: 'skip' }] },
    { results: [{ status: 'stale' }] },
    { results: [{ status: 'new', unstable: { reason: 'pixels' } }] },
    { results: [{ status: 'fail', unrechecked: true }] },
  ])
    expect(() => assertReviewEvidence({ ...report, ...patch } as RunReport)).toThrow();
});
