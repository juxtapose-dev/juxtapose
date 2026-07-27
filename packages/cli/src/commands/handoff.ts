// `jux handoff <storyId>` — print an agent-ready prompt for one story.
//
// Writes to stdout so it pipes: `jux handoff foo--bar | claude -p`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  buildHandoffPrompt,
  encodeStoryId,
  type RunReport,
  type HandoffPayload,
} from '@juxtapose/core';
import { resolveContext, type CommonFlags } from '../context.js';
import { latestRunDir } from '../run-dir.js';
import { DEFAULT_VIEWPORT } from '@juxtapose/core';

export async function handoffCommand(
  storyId: string | undefined,
  flags: CommonFlags,
): Promise<number> {
  if (!storyId) {
    process.stderr.write('jux: handoff needs a story id\n');
    return 2;
  }

  const ctx = await resolveContext(flags);
  const runDir = flags.run
    ? path.resolve(ctx.projectRoot, flags.run)
    : await latestRunDir(ctx.projectRoot);

  if (!runDir) {
    process.stderr.write('jux: no run found. Run `jux run` first.\n');
    return 1;
  }

  const report = JSON.parse(
    await readFile(path.join(runDir, 'report.json'), 'utf8'),
  ) as RunReport;

  const result = report.results.find((r) => r.storyId === storyId);
  if (!result) {
    process.stderr.write(`jux: no result for '${storyId}' in the last run\n`);
    return 1;
  }

  // Look up the source path so the prompt can point at real code.
  const stories = await ctx.platform.enumerate({
    projectRoot: ctx.projectRoot,
    buildDir: ctx.buildDir,
    origin: ctx.origin,
  });
  const story = stories.find((s) => s.storyId === storyId);

  const safe = encodeStoryId(storyId);
  const images = path.join(runDir, 'images');
  const diffDataPath = path.join(runDir, 'diffs', `${safe}.json`);

  // Write the sidecar the prompt points at: the agent reads one small JSON
  // instead of parsing coordinates back out of prose.
  await mkdir(path.join(runDir, 'diffs'), { recursive: true });
  await writeFile(
    diffDataPath,
    JSON.stringify(
      {
        storyId,
        status: result.status,
        mismatchPercent: result.mismatchPercent,
        mismatchPixels: result.mismatchPixels,
        viewport: ctx.config.viewport ?? DEFAULT_VIEWPORT,
        changedRegions: result.changedRegions,
      },
      null,
      2,
    ) + '\n',
  );

  const payload: HandoffPayload = {
    storyId,
    storyTitle: story ? `${story.title} — ${story.name}` : storyId,
    status: result.status,
    mismatchPercent: result.mismatchPercent,
    mismatchPixels: result.mismatchPixels,
    changedRegions: result.changedRegions,
    // Use the story's own viewport when it overrides the project default,
    // or the region-area percentages in the prompt are computed against the
    // wrong denominator.
    viewport: story?.params.viewport ?? ctx.config.viewport ?? DEFAULT_VIEWPORT,
    componentPath: story?.componentPath ?? '',
    diffDataPath,
    images: {
      baseline: path.join(images, `${safe}-baseline.webp`),
      current: path.join(images, `${safe}-current.webp`),
      diff: result.status === 'fail' ? path.join(images, `${safe}-diff.webp`) : undefined,
    },
    projectRoot: ctx.projectRoot,
  };

  process.stdout.write(buildHandoffPrompt(payload) + '\n');
  return 0;
}
