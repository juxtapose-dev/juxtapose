// `jux run` — capture, compare, report.

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  buildComment,
  describeCause,
  gitIsCommit,
  prepareCause,
  type DiffResult,
  buildHtmlReport,
  postComment,
  resolveArtifactUrl,
  resolveGitHubContext,
  resolveAffected,
  runCapture,
  createAncestryCheck,
  alwaysAncestor,
  acquireBrowser,
  encodeStoryId,
  encodeStructure,
  expandVariants,
  selectByStoryId,
  VariantConfigError,
  formatPercent,
  formatPhases,
  phases,
  type Phases,
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
import { EXIT } from '../exit-codes.js';
import { stdio, type Io, type Session } from '../io.js';

const MAX_GROUPS_SHOWN = 10;

export async function runCommand(
  flags: CommonFlags,
  { io = stdio, browser: lent, signal }: Session = {},
): Promise<number> {
  // Checked first: a mistyped ref used to fall through to `git-unavailable`,
  // capture everything, and give every story an unexplained `unknown` cause.
  if (
    flags.since !== undefined &&
    !gitIsCommit(flags.since, path.resolve(flags.project ?? process.cwd()))
  ) {
    io.err(
      `jux run: --since '${flags.since}' is not a commit. Try \`--since main\` or \`--since HEAD~1\`.\n`,
    );
    return EXIT.usage;
  }
  const ctx = await resolveContext(flags);
  const log = (msg: string) => {
    if (!ctx.json) io.err(msg + '\n');
  };

  const p = phases();

  let stories;
  try {
    // One entry per capture: a story's variants are jobs like any other from
    // here on, and the platform's own entries are the default captures.
    stories = await p.time('enumerate', async () =>
      expandVariants(
        await ctx.platform.enumerate({
          projectRoot: ctx.projectRoot,
          buildDir: ctx.buildDir,
          origin: ctx.origin,
        }),
        ctx.config.variants,
      ),
    );
  } catch (err) {
    if (!(err instanceof VariantConfigError)) throw err;
    io.err(`${err.message}\n`);
    return EXIT.usage;
  }

  if (stories.length === 0) {
    io.err('jux: no stories found\n');
    return 1;
  }

  // --story is explicit and wins over --all and affected analysis: a base id
  // selects the story with all its variants, a capture key exactly one.
  let selection: { stories: typeof stories; reason: string };
  if (flags.story?.length) {
    const { selected, unknown } = selectByStoryId(stories, flags.story);
    if (unknown.length > 0) {
      io.err(
        `jux run: no story or capture with id ${unknown.map((id) => `'${id}'`).join(', ')}\n`,
      );
      return EXIT.usage;
    }
    selection = { stories: selected, reason: 'requested' };
  } else
    selection = flags.all
      ? { stories, reason: 'no-baseline' as const }
      : await p.time('affected', () =>
          resolveAffected(stories, flags.since ?? null, {
            projectRoot: ctx.projectRoot,
            configDirs: [...ctx.platform.configDirs],
            buildDir: ctx.buildDir,
          }),
        );

  log(
    `jux: ${selection.stories.length}/${stories.length} stories to capture (${selection.reason})`,
  );

  // Only with --since is there a changed-file set to trace. Lazy: the index
  // reads git and the manifest on the first failing story, never on a green run.
  const cause = flags.since
    ? prepareCause({
        projectRoot: ctx.projectRoot,
        buildDir: ctx.buildDir,
        sinceCommit: flags.since,
        configDirs: [...ctx.platform.configDirs],
      })
    : undefined;

  if (selection.stories.length === 0) {
    const empty = emptyReport(ctx.projectRoot, stories.length);
    await emit(ctx.json, empty, ctx.projectRoot, p, io);
    return 0;
  }

  // The urls platform addresses pages directly; there is nothing to serve.
  const needsServer = !ctx.origin && ctx.platform.name !== 'urls';
  const server = needsServer ? await serveStatic(ctx.buildDir!) : null;
  const baseUrl = ctx.origin ?? server?.url ?? 'about:blank';
  let browser;
  try {
    browser = await p.time('launch', () =>
      lent
        ? lent()
        : acquireBrowser({
            chrome: flags.chrome,
            noDaemon: flags['no-daemon'] === true,
          }),
    );
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n`);
    await server?.close();
    return EXIT.failure;
  }

  const runId = `${Date.now().toString(36)}`;
  const runDir = path.join(ctx.projectRoot, '.juxtapose', 'runs', runId);
  try {
    // Inside the try, so a failed mkdir still closes the browser below.
    await mkdir(path.join(runDir, 'images'), { recursive: true });
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
      phases: p,
      ...(cause ? { cause } : {}),
      runId,
      ...(signal ? { signal } : {}),
      branch: gitBranch(ctx.projectRoot),
      commitSha: gitSha(ctx.projectRoot),
      onArtifact: (a) => writeArtifact(runDir, a),
      onProgress: (done, total, storyId) => {
        if (!ctx.json) {
          io.err(`\r  ${done}/${total}  ${storyId.slice(0, 48).padEnd(48)}`);
        }
      },
    });

    if (!ctx.json) io.err('\r' + ' '.repeat(70) + '\r');

    // A cancelled run (jux mcp) captured only part of the selection. Writing
    // its report would make it the "last run" that check, handoff and approve
    // read, so a cancellation would silently replace the real one.
    if (signal?.aborted) {
      await rm(runDir, { recursive: true, force: true });
      io.err('jux run: cancelled; no report written\n');
      return EXIT.failure;
    }

    await writeFile(
      path.join(runDir, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );

    await emit(ctx.json, report, runDir, p, io);

    if (flags.html) await writeHtmlReport(report, runDir, ctx.store, ctx.json, io);
    // The comment links the artifact only when there is one to link.
    if (flags.comment) await comment(report, ctx.json, Boolean(flags.html), io);

    // Anything needing human or agent judgement blocks. `pass` and `skip` do not.
    const blocking = report.summary.fail + report.summary.new + report.summary.stale;
    return blocking > 0 ? 1 : 0;
  } finally {
    // A lent browser belongs to the session (`jux mcp`) and outlives this call.
    if (!lent) await browser.close().catch(() => {});
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
  io: Io,
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
  if (!json) io.err(`jux: wrote ${out}\n`);
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
  io: Io,
): Promise<void> {
  const ctx = await resolveGitHubContext();
  if (!ctx) {
    if (!json) {
      io.err(
        'jux: --comment had no pull request to post to (needs GITHUB_TOKEN and a pull_request event)\n',
      );
    }
    return;
  }

  const artifactUrl = resolveArtifactUrl(hasHtmlReport);
  // Say why the comment carries no report link, since the two causes want
  // opposite fixes. Name the missing variables rather than guessing at a
  // reason: we only get here once a GitHub context resolved, so "not in
  // Actions" is the one explanation already mostly ruled out.
  if (!artifactUrl && !json) {
    io.err(
      hasHtmlReport
        ? 'jux: no report link in the comment (needs GITHUB_SERVER_URL and GITHUB_RUN_ID)\n'
        : 'jux: no report link in the comment (pass --html to write one)\n',
    );
  }

  const url = await postComment(ctx, buildComment({ report, artifactUrl }));
  if (!json) {
    io.err(url ? `jux: posted ${url}\n` : 'jux: could not post the PR comment\n');
  }
}

async function writeArtifact(runDir: string, a: RunArtifact): Promise<void> {
  const safe = encodeStoryId(a.storyId);
  const images = path.join(runDir, 'images');
  await writeFile(path.join(images, `${safe}-current.webp`), a.current);
  if (a.diff) await writeFile(path.join(images, `${safe}-diff.webp`), a.diff);
  if (a.structure) {
    await writeFile(
      path.join(images, `${safe}-current.structure.json.gz`),
      encodeStructure(a.structure),
    );
  }
}

async function emit(
  json: boolean,
  report: RunReport,
  runDir: string,
  p: Phases,
  io: Io,
): Promise<void> {
  if (json) {
    io.out(JSON.stringify(report) + '\n');
    return;
  }

  const s = report.summary;
  const parts = [
    `${s.pass} pass`,
    s.fail ? `${s.fail} fail` : null,
    s.new ? `${s.new} new` : null,
    s.stale ? `${s.stale} stale` : null,
  ].filter(Boolean);

  io.out(`\n${parts.join('  ·  ')}   (${(report.durationMs / 1000).toFixed(1)}s)\n`);

  const timings = formatPhases(p);
  if (timings) io.out(`  ${timings}\n`);

  const needsReview = report.results.filter(
    (r) => r.status !== 'pass' && r.status !== 'skip',
  );
  if (needsReview.length > 0) {
    io.out('\n');
    for (const r of needsReview.slice(0, 20)) {
      const detail =
        r.status === 'fail' && r.mismatchPercent > 0
          ? ` ${formatPercent(r.mismatchPercent)}`
          : r.error
            ? ` ${r.error}`
            : '';
      io.out(`  ${r.status.padEnd(6)} ${r.storyId}${detail}\n`);
      for (const line of explain(r)) io.out(`         ${line}\n`);
    }
    if (needsReview.length > 20) {
      io.out(`  …and ${needsReview.length - 20} more\n`);
    }
    // Bounded like the review list: 500 groups would be 1,000 lines. The
    // report has them all.
    if (report.groups?.length) {
      const n = report.groups.length;
      io.out(`\n  ${n} change${n === 1 ? '' : 's'} shared by several stories:\n`);
      for (const g of report.groups.slice(0, MAX_GROUPS_SHOWN)) {
        const ids = g.storyIds.slice(0, 5).join(', ');
        const more = g.storyIds.length > 5 ? `, …${g.storyIds.length - 5} more` : '';
        io.out(`  ${g.summary}\n    ${ids}${more}\n`);
      }
      if (n > MAX_GROUPS_SHOWN)
        io.out(`  …and ${n - MAX_GROUPS_SHOWN} more (see report.json)\n`);
    }
    io.out(`\n  report: ${path.join(runDir, 'report.json')}\n`);
    io.out(`  approve all: jux approve --all\n`);
  }
}

/**
 * Show enough precision that a real change never displays as "0.00%".
 *
 * A one-word text edit on a large viewport lands around 0.004%; rounding that
 * to two decimals prints "0.00%" next to the word "fail", which reads as a
 * tool bug and teaches people to distrust the output.
 */

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

/** What an agent reads first under a failing story: the cause (the same
 *  sentence the handoff prints), then the structural summary. One line
 *  each; the handoff has the rest. An `unknown` cause is left to the
 *  handoff: under every story of a Storybook build it would be noise. */
function explain(r: DiffResult): string[] {
  const v = r.structural;
  if (!v) return [];
  const why =
    v.cause && v.cause.kind !== 'unknown' ? [`cause: ${describeCause(v.cause)}`] : [];
  return [...why, v.summary];
}
