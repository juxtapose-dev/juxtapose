// `jux handoff <storyId>` — print an agent-ready prompt for one story.
//
// Writes to stdout so it pipes: `jux handoff foo--bar | claude -p`.

import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  buildHandoffPrompt,
  handoffVariant,
  encodeStoryId,
  ManifestConflictError,
  parseRunReport,
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

  const report = parseRunReport(await readFile(path.join(runDir, 'report.json'), 'utf8'));

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
  // The platform knows a variant by its story's own id, not the capture key.
  const baseId = result.baseStoryId ?? storyId;
  const story = stories.find((s) => s.storyId === baseId);

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
        ...(result.unstable ? { unstable: result.unstable } : {}),
        ...(result.flake ? { flake: result.flake } : {}),
        mismatchPercent: result.mismatchPercent,
        mismatchPixels: result.mismatchPixels,
        ...(result.baselineImage ? { baselineImage: result.baselineImage } : {}),
        viewport,
        changedRegions: result.changedRegions,
        structural: result.structural,
        ...(result.settle ? { settle: result.settle } : {}),
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
  } catch (err) {
    // A manifest with conflict markers is the user's to regenerate (exit 2),
    // not a store that merely cannot say.
    if (err instanceof ManifestConflictError) throw err;
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

  const flakeGroup = report.flakeGroups?.find((g) => g.storyIds.includes(storyId));
  const variant = handoffVariant(result);
  const payload: HandoffPayload = {
    storyId,
    storyTitle: story ? `${story.title} — ${story.name}` : storyId,
    status: result.status,
    ...(result.unstable ? { unstable: result.unstable } : {}),
    ...(result.flake ? { flake: result.flake } : {}),
    ...(flakeGroup ? { flakeGroup } : {}),
    mismatchPercent: result.mismatchPercent,
    mismatchPixels: result.mismatchPixels,
    changedRegions: result.changedRegions,
    ...(result.baselineImage ? { baselineImage: result.baselineImage } : {}),
    ...(['git', 'fs'].includes(ctx.config.storage?.kind ?? '')
      ? { imagesCommitted: true }
      : {}),
    viewport,
    componentPath: story?.componentPath ?? '',
    diffDataPath,
    ...(result.structural ? { structural: result.structural } : {}),
    ...(cropsCommand ? { cropsCommand } : {}),
    images: {
      baseline: haveBaseline ? baselineImage : undefined,
      current: currentImage,
      // No pixel diff runs when the baseline image is unavailable, so no overlay exists.
      diff:
        result.status === 'fail' && !result.baselineImage
          ? path.join(images, `${safe}-diff.webp`)
          : undefined,
    },
    projectRoot: ctx.projectRoot,
    ...(variant ? { variant } : {}),
    ...(result.settle ? { settle: result.settle } : {}),
    ...(result.skippedBy ? { skippedBy: result.skippedBy } : {}),
  };

  io.out(buildHandoffPrompt(payload) + '\n');
  return 0;
}
