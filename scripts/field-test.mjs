#!/usr/bin/env node
// Capture a static Storybook several times and report how many stories hash
// identically across the passes, plus wall time and per-story timing.
//
// Usage: node scripts/field-test.mjs <buildDir> [passes] [--storybook <name>]
//          [--json <file>] [--report-dir <dir>]
//
// With --storybook, the run is also a gate: it reads that Storybook's entry in
// scripts/field-tests.config.json and exits 1 if a capture errored and is not
// in `allowedErrors`, if a story differs across passes and is not in
// `knownVariable`, or if the wall time of any pass exceeds `maxWallSeconds`.
// The human summary goes to stdout and, when set, to $GITHUB_STEP_SUMMARY.
// --json writes the machine-readable result; --report-dir copies each pass's
// report.json into that directory.
//
// Each pass is one `jux run --all` with a fresh browser launch and its own
// temporary state dir. Every later pass is compared with pass 1 through
// `jux diff --runs --json`. Needs a built CLI (`pnpm build`).

import { execFile } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const flags = {};
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (['--storybook', '--json', '--report-dir'].includes(argv[i]))
    flags[argv[i]] = argv[++i];
  else positional.push(argv[i]);
}
const [buildArg, passArg = '3'] = positional;
const passes = Number(passArg);
if (!buildArg || !Number.isInteger(passes) || passes < 2) {
  console.error(
    'usage: node scripts/field-test.mjs <buildDir> [passes >= 2] [--storybook <name>] [--json <file>] [--report-dir <dir>]',
  );
  process.exit(2);
}
const gate = flags['--storybook']
  ? JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, 'field-tests.config.json'), 'utf8'),
    ).storybooks?.[flags['--storybook']]
  : undefined;
if (flags['--storybook'] && !gate) {
  console.error(
    `no entry for "${flags['--storybook']}" in scripts/field-tests.config.json`,
  );
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
  JSON.stringify({
    platform: 'storybook',
    buildDir,
    ...(gate?.concurrency ? { concurrency: gate.concurrency } : {}),
  }),
);
const jux = (args, state) =>
  run('node', [cli, ...args, '--project', project], {
    env: { ...process.env, JUX_STATE_DIR: state },
    maxBuffer: 256 * 1024 * 1024,
    // Exit 1 means "needs review" (every story is new), not a failure.
  }).catch((err) => (err.stdout ? err : Promise.reject(err)));

const lines = [];
const say = (line) => {
  console.log(line);
  lines.push(line);
};
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
      const errors = report.results.filter((r) => r.error).length;
      const errored = report.results.filter((r) => r.error).map((r) => r.storyId);
      runs.push({ runId, wall, results: report.results.length, errored });
      if (flags['--report-dir']) {
        mkdirSync(flags['--report-dir'], { recursive: true });
        copyFileSync(
          path.join(project, '.juxtapose/runs', runId, 'report.json'),
          path.join(flags['--report-dir'], `report-pass${i}.json`),
        );
      }
      say(
        `pass ${i}: ${report.results.length} results, ${errors} errors, wall ${wall.toFixed(1)} s, ` +
          `p50 ${percentile(ms, 50)} ms, p95 ${percentile(ms, 95)} ms`,
      );
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  }
  const differing = new Set();
  const comparisons = [];
  for (let i = 1; i < passes; i++) {
    const { stdout } = await jux(
      ['diff', '--runs', runs[0].runId, runs[i].runId, '--json'],
      tmpdir(),
    );
    const diff = JSON.parse(stdout);
    const { summary } = diff;
    for (const id of [...diff.different, ...diff.missing]) differing.add(id);
    comparisons.push({ pass: i + 1, ...summary });
    const total = summary.identical + summary.different + summary.missing;
    say(
      `pass 1 = pass ${i + 1}: ${summary.identical}/${total} byte-identical` +
        `, ${summary.different} differ, ${summary.missing} missing`,
    );
  }

  const failures = [];
  let expected = { knownVariable: [], allowedErrors: [] };
  if (gate) {
    expected = {
      knownVariable: gate.knownVariable ?? [],
      allowedErrors: gate.allowedErrors ?? [],
    };
    const errored = [...new Set(runs.flatMap((r) => r.errored))];
    for (const id of errored.filter((id) => !expected.allowedErrors.includes(id))) {
      failures.push(`capture error not on the allowlist: ${id}`);
    }
    for (const id of [...differing]
      .filter((id) => !expected.knownVariable.includes(id))
      .sort()) {
      failures.push(`differs across passes and is not known-variable: ${id}`);
    }
    for (const [i, r] of runs.entries()) {
      if (r.wall > gate.maxWallSeconds) {
        failures.push(
          `pass ${i + 1} wall ${r.wall.toFixed(1)} s exceeds the ${gate.maxWallSeconds} s ceiling`,
        );
      }
    }
    const stale = expected.knownVariable.filter((id) => !differing.has(id));
    if (stale.length)
      say(`note: known-variable stories that were stable this time: ${stale.join(', ')}`);
    for (const f of failures) say(`FAIL: ${f}`);
    say(failures.length ? `gate: FAILED (${failures.length})` : 'gate: passed');
  }

  if (flags['--json']) {
    writeFileSync(
      flags['--json'],
      JSON.stringify(
        {
          storybook: flags['--storybook'] ?? null,
          passes: runs.map(({ runId, wall, results, errored }) => ({
            runId,
            wall,
            results,
            errored,
          })),
          comparisons,
          differing: [...differing].sort(),
          failures,
        },
        null,
        2,
      ),
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Field test: ${flags['--storybook'] ?? buildDir}\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`,
    );
  }
  if (failures.length) process.exitCode = 1;
} finally {
  rmSync(project, { recursive: true, force: true });
}
