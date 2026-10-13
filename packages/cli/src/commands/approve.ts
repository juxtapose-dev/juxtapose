// `jux approve` — promote captures from the last run to baselines.
//
// Approval writes the manifest, which is committed. So approving is a git diff
// a reviewer can see and question, not an invisible mutation of a bucket.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeStructure, encodeStoryId, type RunReport } from '@juxtapose/core';
import { resolveContext, gitSha, type CommonFlags } from '../context.js';
import { latestRunDir } from '../run-dir.js';

export async function approveCommand(flags: CommonFlags): Promise<number> {
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

  const requested = new Set(flags.story ?? []);
  const candidates = report.results.filter((r) => {
    if (requested.size > 0) return requested.has(r.storyId);
    if (!flags.all) return false;
    return r.status === 'fail' || r.status === 'new' || r.status === 'stale';
  });

  if (requested.size === 0 && !flags.all) {
    process.stderr.write('jux: pass --story <id> or --all\n');
    return 2;
  }

  if (candidates.length === 0) {
    if (!ctx.json) process.stdout.write('jux: nothing to approve\n');
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
    try {
      const image = await readFile(imagePath);
      const gz = await readFile(
        imagePath.replace(/-current\.webp$/, '-current.structure.json.gz'),
      ).catch(() => null);
      // Structure explains a diff, it never gates one: a corrupt sidecar is
      // treated as absent so the image still gets approved.
      let structureHash: string | undefined;
      let structureGz: Buffer | null = null;
      if (gz) {
        try {
          structureHash = decodeStructure(gz).structureHash;
          structureGz = gz;
        } catch {
          structureHash = undefined;
        }
      }
      await ctx.store.put(result.storyId, image, {
        commit,
        approvedBy,
        approvedAt,
        env,
        ...(structureHash ? { structureHash } : {}),
      });
      if (structureGz) await ctx.store.putStructure?.(result.storyId, structureGz);
      approved.push(result.storyId);
    } catch {
      failed.push({ storyId: result.storyId, reason: 'capture image missing from run' });
    }
  }

  if (ctx.json) {
    process.stdout.write(JSON.stringify({ approved, failed }) + '\n');
  } else {
    process.stdout.write(`jux: approved ${approved.length} ${plural(approved.length)}\n`);
    for (const f of failed) process.stderr.write(`  skipped ${f.storyId}: ${f.reason}\n`);
    if (approved.length > 0) {
      process.stdout.write(
        '\n  Commit juxtapose.manifest.json and .juxtapose/baselines/ to record this.\n',
      );
    }
  }

  return failed.length > 0 ? 1 : 0;
}

const plural = (n: number) => (n === 1 ? 'story' : 'stories');
