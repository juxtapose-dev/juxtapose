// `jux run` — capture, compare, report.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  buildComment,
  buildHtmlReport,
  postComment,
  resolveArtifactUrl,
  resolveGitHubContext,
  resolveAffected,
  runCapture,
  createAncestryCheck,
  alwaysAncestor,
  deterministicLaunchOptions,
  encodeStoryId,
  type BaselineStore,
  type RunArtifact,
  type RunReport,
} from '@juxtapose/core';
import {
  resolveContext,
  gitBranch,
  gitSha,
  isGitRepo,
  type CommonFlags,
} from '../context.js';
import { serveStatic } from '../serve-static.js';

export async function runCommand(flags: CommonFlags): Promise<number> {
  const ctx = await resolveContext(flags);
  const log = (msg: string) => {
    if (!ctx.json) process.stderr.write(msg + '\n');
  };

  const stories = await ctx.platform.enumerate({
    projectRoot: ctx.projectRoot,
    buildDir: ctx.buildDir,
    origin: ctx.origin,
  });

  if (stories.length === 0) {
    process.stderr.write('jux: no stories found\n');
    return 1;
  }

  const selection = flags.all
    ? { stories, reason: 'no-baseline' as const }
    : await resolveAffected(stories, flags.since ?? null, {
        projectRoot: ctx.projectRoot,
        configDirs: [...ctx.platform.configDirs],
        buildDir: ctx.buildDir,
      });

  log(
    `jux: ${selection.stories.length}/${stories.length} stories to capture (${selection.reason})`,
  );

  if (selection.stories.length === 0) {
    const empty = emptyReport(ctx.projectRoot, stories.length);
    await emit(ctx.json, empty, ctx.projectRoot);
    return 0;
  }

  const server = ctx.origin ? null : await serveStatic(ctx.buildDir!);
  const baseUrl = ctx.origin ?? server!.url;
  const browser = await chromium.launch(deterministicLaunchOptions());

  const runId = `${Date.now().toString(36)}`;
  const runDir = path.join(ctx.projectRoot, '.juxtapose', 'runs', runId);
  await mkdir(path.join(runDir, 'images'), { recursive: true });

  try {
    const report = await runCapture({
      browser,
      platform: ctx.platform,
      store: ctx.store,
      baseUrl,
      stories: selection.stories,
      totalCount: stories.length,
      config: ctx.config,
      ancestry: isGitRepo(ctx.projectRoot)
        ? createAncestryCheck(ctx.projectRoot)
        : alwaysAncestor,
      runId,
      branch: gitBranch(ctx.projectRoot),
      commitSha: gitSha(ctx.projectRoot),
      onArtifact: (a) => writeArtifact(runDir, a),
      onProgress: (done, total, storyId) => {
        if (!ctx.json) {
          process.stderr.write(
            `\r  ${done}/${total}  ${storyId.slice(0, 48).padEnd(48)}`,
          );
        }
      },
    });

    if (!ctx.json) process.stderr.write('\r' + ' '.repeat(70) + '\r');

    await writeFile(
      path.join(runDir, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );

    await emit(ctx.json, report, runDir);

    if (flags.html) await writeHtmlReport(report, runDir, ctx.store, ctx.json);
    // The comment links the artifact only when there is one to link.
    if (flags.comment) await comment(report, ctx.json, Boolean(flags.html));

    // Anything needing human or agent judgement blocks. `pass` and `skip` do not.
    const blocking = report.summary.fail + report.summary.new + report.summary.stale;
    return blocking > 0 ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
    await server?.close();
  }
}

/**
 * Write the self-contained report.
 *
 * Reads the images back off disk rather than holding every capture in memory:
 * a 700-story suite would otherwise need all of them resident at once just to
 * render a report about the handful that failed.
 */
async function writeHtmlReport(
  report: RunReport,
  runDir: string,
  store: BaselineStore,
  json: boolean,
): Promise<void> {
  const images = new Map<
    string,
    { baseline?: Buffer; current?: Buffer; diff?: Buffer }
  >();

  const dir = path.join(runDir, 'images');
  for (const result of report.results) {
    if (result.status === 'pass' || result.status === 'skip') continue;
    const safe = encodeStoryId(result.storyId);
    images.set(result.storyId, {
      // Baselines live in the store, not the run directory — the run only
      // writes what it captured.
      baseline: (await store.get(result.storyId)) ?? undefined,
      current: await readIfPresent(path.join(dir, `${safe}-current.webp`)),
      diff: await readIfPresent(path.join(dir, `${safe}-diff.webp`)),
    });
  }

  const out = path.join(runDir, 'report.html');
  await writeFile(out, buildHtmlReport({ report, images }));
  if (!json) process.stderr.write(`jux: wrote ${out}\n`);
}

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch {
    return undefined;
  }
}

/**
 * Post the summary to the PR, if we are in one.
 *
 * Deliberately never throws and never changes the exit code: reporting is a
 * side effect. A missing token, a push rather than a pull request, or a
 * GitHub outage should not turn a passing visual run into a failing build.
 */
async function comment(
  report: RunReport,
  json: boolean,
  hasHtmlReport: boolean,
): Promise<void> {
  const ctx = await resolveGitHubContext();
  if (!ctx) {
    if (!json) {
      process.stderr.write(
        'jux: --comment had no pull request to post to (needs GITHUB_TOKEN and a pull_request event)\n',
      );
    }
    return;
  }

  const artifactUrl = resolveArtifactUrl(hasHtmlReport);
  const url = await postComment(ctx, buildComment({ report, artifactUrl }));
  if (!json) {
    process.stderr.write(
      url ? `jux: posted ${url}\n` : 'jux: could not post the PR comment\n',
    );
  }
}

async function writeArtifact(runDir: string, a: RunArtifact): Promise<void> {
  const safe = encodeStoryId(a.storyId);
  const images = path.join(runDir, 'images');
  await writeFile(path.join(images, `${safe}-current.webp`), a.current);
  if (a.diff) await writeFile(path.join(images, `${safe}-diff.webp`), a.diff);
}

async function emit(json: boolean, report: RunReport, runDir: string): Promise<void> {
  if (json) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return;
  }

  const s = report.summary;
  const parts = [
    `${s.pass} pass`,
    s.fail ? `${s.fail} fail` : null,
    s.new ? `${s.new} new` : null,
    s.stale ? `${s.stale} stale` : null,
  ].filter(Boolean);

  process.stdout.write(
    `\n${parts.join('  ·  ')}   (${(report.durationMs / 1000).toFixed(1)}s)\n`,
  );

  const needsReview = report.results.filter(
    (r) => r.status !== 'pass' && r.status !== 'skip',
  );
  if (needsReview.length > 0) {
    process.stdout.write('\n');
    for (const r of needsReview.slice(0, 20)) {
      const detail =
        r.status === 'fail' && r.mismatchPercent > 0
          ? ` ${formatPercent(r.mismatchPercent)}`
          : r.error
            ? ` ${r.error}`
            : '';
      process.stdout.write(`  ${r.status.padEnd(6)} ${r.storyId}${detail}\n`);
    }
    if (needsReview.length > 20) {
      process.stdout.write(`  …and ${needsReview.length - 20} more\n`);
    }
    process.stdout.write(`\n  report: ${path.join(runDir, 'report.json')}\n`);
    process.stdout.write(`  approve all: jux approve --all\n`);
  }
}

/**
 * Show enough precision that a real change never displays as "0.00%".
 *
 * A one-word text edit on a large viewport lands around 0.004%; rounding that
 * to two decimals prints "0.00%" next to the word "fail", which reads as a
 * tool bug and teaches people to distrust the output.
 */
function formatPercent(pct: number): string {
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  if (pct > 0) return '<0.01%';
  return '0%';
}

function emptyReport(projectRoot: string, totalCount: number): RunReport {
  return {
    runId: 'empty',
    branch: gitBranch(projectRoot),
    commitSha: gitSha(projectRoot),
    capturedCount: 0,
    totalCount,
    results: [],
    summary: { pass: 0, fail: 0, new: 0, stale: 0, skip: 0 },
    durationMs: 0,
    startedAt: new Date().toISOString(),
  };
}
