// `jux approve` — promote captures from the last run to baselines.
//
// Approval writes the manifest, which is committed. So approving is a git diff
// a reviewer can see and question, not an invisible mutation of a bucket.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  approveCapture,
  encodeStoryId,
  parseRunReport,
  type DiffResult,
} from '@juxtapose/core';
import { resolveContext, gitSha, type CommonFlags } from '../context.js';
import { errorMessage } from '../guards.js';
import { latestRunDir } from '../run-dir.js';
import { stdio, type Session } from '../io.js';

export async function approveCommand(
  flags: CommonFlags,
  { io = stdio }: Session = {},
): Promise<number> {
  const ctx = await resolveContext(flags);

  const runDir = flags.run
    ? path.resolve(ctx.projectRoot, flags.run)
    : await latestRunDir(ctx.projectRoot);

  if (!runDir) {
    io.err('jux: no run found. Run `jux run` first.\n');
    return 1;
  }

  const report = parseRunReport(await readFile(path.join(runDir, 'report.json'), 'utf8'));

  const requested = new Set(flags.story ?? []);
  const needsApproval = (r: DiffResult) =>
    r.status === 'fail' || r.status === 'new' || r.status === 'stale';
  // A requested id naming a story with variants in this run is a fan-out:
  // every capture of it, its default included, is approved only if it needs
  // it. A skipped capture has no image (it failed the whole call) and a
  // passing one would only rewrite its approval metadata. An id with no
  // variants in the run is an exact key, approved as asked.
  const fanOut = new Set(
    report.results.flatMap((r) =>
      r.baseStoryId !== undefined && requested.has(r.baseStoryId) ? [r.baseStoryId] : [],
    ),
  );
  const candidates = report.results.filter((r) => {
    if (requested.size > 0) {
      const story = r.baseStoryId ?? r.storyId;
      if (fanOut.has(story))
        return needsApproval(r) || (requested.has(r.storyId) && r.storyId !== story);
      return requested.has(r.storyId);
    }
    if (!flags.all) return false;
    return needsApproval(r);
  });

  if (requested.size === 0 && !flags.all) {
    io.err('jux: pass --story <id> or --all\n');
    return 2;
  }

  if (candidates.length === 0) {
    // JSON callers always get an answer, not empty output.
    io.out(
      ctx.json
        ? JSON.stringify({ approved: [], failed: [] }) + '\n'
        : 'jux: nothing to approve\n',
    );
    return 0;
  }

  const commit = gitSha(ctx.projectRoot);
  const approvedBy = process.env.JUXTAPOSE_USER ?? process.env.USER ?? 'unknown';
  const approvedAt = new Date().toISOString();
  // From the run, not from here: approving never launches a browser.
  const env = report.env;
  const approved: string[] = [];
  const failed: { storyId: string; reason: string }[] = [];

  for (const result of candidates) {
    const imagePath = path.join(
      runDir,
      'images',
      `${encodeStoryId(result.storyId)}-current.webp`,
    );
    let image: Buffer;
    try {
      image = await readFile(imagePath);
    } catch {
      failed.push({ storyId: result.storyId, reason: 'capture image missing from run' });
      continue;
    }
    try {
      const { structureError } = await approveCapture(
        ctx.store,
        result.storyId,
        image,
        { commit, approvedBy, approvedAt, env },
        imagePath,
      );
      approved.push(result.storyId);
      // The image is approved; a lost sidecar costs explanation, not status.
      if (structureError) {
        io.err(
          `jux: approved ${result.storyId}, but its structure was not saved: ${structureError}\n`,
        );
      }
    } catch (err) {
      failed.push({
        storyId: result.storyId,
        reason: `could not write baseline: ${errorMessage(err)}`,
      });
    }
  }

  if (ctx.json) {
    io.out(JSON.stringify({ approved, failed }) + '\n');
  } else {
    io.out(`jux: approved ${approved.length} ${plural(approved.length)}\n`);
    for (const f of failed) io.err(`  skipped ${f.storyId}: ${f.reason}\n`);
    if (approved.length > 0) {
      io.out(
        '\n  Commit juxtapose.manifest.json and .juxtapose/baselines/ to record this.\n',
      );
    }
  }

  return failed.length > 0 ? 1 : 0;
}

const plural = (n: number) => (n === 1 ? 'story' : 'stories');
