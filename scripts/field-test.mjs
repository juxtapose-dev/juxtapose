#!/usr/bin/env node
// Capture a static Storybook several times and report how many stories hash
// identically across the passes, plus wall time and per-story timing.
//
// Usage: node scripts/field-test.mjs <buildDir> [passes]
//
// Each pass is one `jux run --all` with a fresh browser launch and its own
// temporary state dir. Every later pass is compared with pass 1 through
// `jux diff --runs --json`. Needs a built CLI (`pnpm build`).

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [buildArg, passArg = '3'] = process.argv.slice(2);
const passes = Number(passArg);
if (!buildArg || !Number.isInteger(passes) || passes < 2) {
  console.error('usage: node scripts/field-test.mjs <buildDir> [passes >= 2]');
  process.exit(2);
}
const buildDir = path.resolve(buildArg);
const cli = path.resolve(import.meta.dirname, '../packages/cli/dist/index.js');
if (!existsSync(cli)) {
  console.error(`built CLI not found at ${cli}; run \`pnpm build\` first`);
  process.exit(2);
}

// A temp project holds the config and the runs, so nothing is written to the
// repo. The argv is an array: no shell sees the paths.
const project = mkdtempSync(path.join(tmpdir(), 'jux-field-test-'));
writeFileSync(
  path.join(project, 'juxtapose.config.json'),
  JSON.stringify({ platform: 'storybook', buildDir }),
);
const jux = (args, state) =>
  run('node', [cli, ...args, '--project', project], {
    env: { ...process.env, JUX_STATE_DIR: state },
    maxBuffer: 256 * 1024 * 1024,
    // Exit 1 means "needs review" (every story is new), not a failure.
  }).catch((err) => (err.stdout ? err : Promise.reject(err)));

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

try {
  const runs = [];
  for (let i = 1; i <= passes; i++) {
    const state = mkdtempSync(path.join(tmpdir(), 'jux-field-state-'));
    const started = Date.now();
    try {
      const { stdout } = await jux(['run', '--all', '--json', '--no-daemon'], state);
      const wall = (Date.now() - started) / 1000;
      const { runId } = JSON.parse(stdout);
      const report = JSON.parse(
        readFileSync(path.join(project, '.juxtapose/runs', runId, 'report.json'), 'utf8'),
      );
      const ms = report.results.map((r) => r.durationMs).sort((a, b) => a - b);
      const errors = report.results.filter((r) => r.status === 'error').length;
      runs.push({ runId, wall });
      console.log(
        `pass ${i}: ${report.results.length} results, ${errors} errors, wall ${wall.toFixed(1)} s, ` +
          `p50 ${percentile(ms, 50)} ms, p95 ${percentile(ms, 95)} ms`,
      );
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  }
  for (let i = 1; i < passes; i++) {
    const { stdout } = await jux(
      ['diff', '--runs', runs[0].runId, runs[i].runId, '--json'],
      tmpdir(),
    );
    const { summary } = JSON.parse(stdout);
    const total = summary.identical + summary.different + summary.missing;
    console.log(
      `pass 1 = pass ${i + 1}: ${summary.identical}/${total} byte-identical` +
        `, ${summary.different} differ, ${summary.missing} missing`,
    );
  }
} finally {
  rmSync(project, { recursive: true, force: true });
}
