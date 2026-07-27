// `jux check` — read the last run and exit 0/1 without capturing anything.
//
// For CI re-checks after an approval lands, and for agents that want to poll
// state without paying for a capture.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunReport } from '@juxtapose/core';
import { resolveContext, type CommonFlags } from '../context.js';
import { latestRunDir } from '../run-dir.js';

export async function checkCommand(flags: CommonFlags): Promise<number> {
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

  const manifest = await ctx.store.readManifest();

  // A story blocks unless the run passed it, or an approval has landed since
  // the run — which is exactly the case `check` exists to detect.
  const blocking = report.results.filter((r) => {
    if (r.status === 'pass' || r.status === 'skip') return false;
    return !manifest.baselines[r.storyId];
  });

  if (ctx.json) {
    process.stdout.write(
      JSON.stringify({
        ok: blocking.length === 0,
        blocking: blocking.map((r) => ({ storyId: r.storyId, status: r.status })),
        runId: report.runId,
      }) + '\n',
    );
  } else if (blocking.length === 0) {
    process.stdout.write('jux: all stories approved\n');
  } else {
    process.stdout.write(
      `jux: ${blocking.length} ${blocking.length === 1 ? 'story needs' : 'stories need'} review\n`,
    );
    for (const r of blocking.slice(0, 20)) {
      process.stdout.write(`  ${r.status.padEnd(6)} ${r.storyId}\n`);
    }
  }

  return blocking.length > 0 ? 1 : 0;
}
