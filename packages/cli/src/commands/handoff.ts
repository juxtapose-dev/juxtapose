// `jux handoff <storyId>` — print an agent-ready prompt for one story.
//
// Writes to stdout so it pipes: `jux handoff foo--bar | claude -p`.

import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  buildHandoffPrompt,
  encodeStoryId,
  type RunReport,
  type HandoffPayload,
  shellQuote,
} from '@juxtapose/core';
import { resolveContext, type CommonFlags } from '../context.js';
import { latestRunDir } from '../run-dir.js';
import { writeFresh } from '../symlink-guard.js';
import { stdio, type Session } from '../io.js';
import { DEFAULT_VIEWPORT } from '@juxtapose/core';

export async function handoffCommand(
  storyId: string | undefined,
  flags: CommonFlags,
  { io = stdio }: Session = {},
): Promise<number> {
  if (!storyId) {
    io.err('jux: handoff needs a story id\n');
    return 2;
  }

  const ctx = await resolveContext(flags);
  const runDir = flags.run
    ? path.resolve(ctx.projectRoot, flags.run)
    : await latestRunDir(ctx.projectRoot);

  if (!runDir) {
    io.err('jux: no run found. Run `jux run` first.\n');
    return 1;
  }

  const report = JSON.parse(
    await readFile(path.join(runDir, 'report.json'), 'utf8'),
  ) as RunReport;

  const result = report.results.find((r) => r.storyId === storyId);
  if (!result) {
    io.err(`jux: no result for '${storyId}' in the last run\n`);
    return 1;
  }

  // Look up the source path so the prompt can point at real code. The report
  // records what changed, not where the component lives.
  const stories = await ctx.platform.enumerate({
    projectRoot: ctx.projectRoot,
    buildDir: ctx.buildDir,
    origin: ctx.origin,
  });
  const story = stories.find((s) => s.storyId === storyId);

  // The viewport the capture actually used, which is what changedRegions
  // coordinates are relative to. Falling back to the project default here was
  // wrong for any story with a per-story override: the region-area percentages
  // came out against the wrong denominator.
  const viewport = result.viewport ?? ctx.config.viewport ?? DEFAULT_VIEWPORT;

  const safe = encodeStoryId(storyId);
  const images = path.join(runDir, 'images');
  const diffDataPath = path.join(runDir, 'diffs', `${safe}.json`);

  // Write the sidecar the prompt points at: the agent reads one small JSON
  // instead of parsing coordinates back out of prose.
  await mkdir(path.join(runDir, 'diffs'), { recursive: true });
  // writeFresh, not writeFile: `jux mcp` runs handoffs in parallel under a
  // shared lock on the run, and two truncating writes of one story's sidecar
  // could interleave; writeFresh serializes per path and never follows a link.
  await writeFresh(
    diffDataPath,
    JSON.stringify(
      {
        storyId,
        status: result.status,
        mismatchPercent: result.mismatchPercent,
        mismatchPixels: result.mismatchPixels,
        viewport,
        changedRegions: result.changedRegions,
        structural: result.structural,
      },
      null,
      2,
    ) + '\n',
  );

  // The baseline lives in the store, not the run dir (jux run writes only
  // what it captured); the old `-baseline.webp` run-dir path never existed.
  let baselineImage: string | undefined;
  try {
    baselineImage = ctx.store.locate?.(storyId);
  } catch {
    // A store that cannot say just means no crops command.
  }
  const currentImage = path.join(images, `${safe}-current.webp`);
  const haveBaseline = baselineImage !== undefined && existsSync(baselineImage);
  const cropsCommand =
    result.status === 'fail' &&
    baselineImage !== undefined &&
    haveBaseline &&
    existsSync(currentImage)
      ? `jux diff ${shellQuote(baselineImage)} ${shellQuote(currentImage)} --crops --project ${shellQuote(ctx.projectRoot)}`
      : undefined;

  const payload: HandoffPayload = {
    storyId,
    storyTitle: story ? `${story.title} — ${story.name}` : storyId,
    status: result.status,
    mismatchPercent: result.mismatchPercent,
    mismatchPixels: result.mismatchPixels,
    changedRegions: result.changedRegions,
    viewport,
    componentPath: story?.componentPath ?? '',
    diffDataPath,
    ...(result.structural ? { structural: result.structural } : {}),
    ...(cropsCommand ? { cropsCommand } : {}),
    images: {
      baseline: haveBaseline ? baselineImage : undefined,
      current: currentImage,
      diff: result.status === 'fail' ? path.join(images, `${safe}-diff.webp`) : undefined,
    },
    projectRoot: ctx.projectRoot,
  };

  io.out(buildHandoffPrompt(payload) + '\n');
  return 0;
}
