#!/usr/bin/env node
// Capture a static Storybook several times and report how many stories hash
// identically across the passes, plus wall time and per-story timing.
//
// Usage: node scripts/field-test.mjs <buildDir> [passes] [--storybook <name>]
//          [--json <file>] [--report-dir <dir>] [--stories <id,id,...>]
//
// With --storybook, the run is also a gate: it reads that Storybook's entry in
// scripts/field-tests.config.json and exits 1 if a capture errored and is not
// in `allowedErrors`, if a story differs across passes and is not in
// `knownVariable`, or if the wall time of any pass exceeds `maxWallSeconds`.
// The human summary goes to stdout and, when set, to $GITHUB_STEP_SUMMARY.
// --json writes the machine-readable result; --report-dir copies each pass's
// report.json into that directory. With --report-dir, every story whose hash
// differs between any pass and pass 1 (and every story that errored) also has
// its capture image and structure sidecar from each pass copied to
// <dir>/images/<storyId>/pass-<n>-<hash8>.webp, with a diff.md listing the
// hashes, up to a total of 200 MB.
//
// --stories captures only the listed story ids (one `jux run --story` each)
// and turns the run into an investigation: the gate is skipped, nothing fails.
//
// Each pass is one `jux run --all --no-recheck` with a fresh browser launch and its own
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
  statSync,
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
  if (
    ['--storybook', '--json', '--report-dir', '--stories', '--concurrency'].includes(
      argv[i],
    )
  )
    flags[argv[i]] = argv[++i];
  else positional.push(argv[i]);
}
const [buildArg, passArg = '3'] = positional;
const passes = Number(passArg);
if (!buildArg || !Number.isInteger(passes) || passes < 2) {
  console.error(
    'usage: node scripts/field-test.mjs <buildDir> [passes >= 2] [--storybook <name>] [--json <file>] [--report-dir <dir>] [--stories <id,id,...>]',
  );
  process.exit(2);
}
const storyIds = (flags['--stories'] ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const investigate = storyIds.length > 0;
const concurrency =
  flags['--concurrency'] === undefined ? undefined : Number(flags['--concurrency']);
if (
  concurrency !== undefined &&
  (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3)
) {
  console.error('--concurrency must be 1, 2, or 3');
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
    ...((concurrency ?? gate?.concurrency)
      ? { concurrency: concurrency ?? gate.concurrency }
      : {}),
  }),
);
const MAX_IMAGE_BYTES = 200 * 1024 * 1024;
const hash8 = (h) => (h ?? 'nohash').replace(/^sha256:/, '').slice(0, 8);
// Mirrors encodeStoryId in packages/core/src/baseline/git-store.ts.
const encodeStoryId = (id) =>
  id.replace(
    /[^a-zA-Z0-9_-]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'),
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
// Copy each differing or errored story's capture from every pass's run dir.
// `jux run` writes <encoded id>-current.webp and -current.structure.json.gz
// there; the recheck capture is not stored, only its hash (in diff.md).
function copyImages(runs, ids, reportDir) {
  let bytes = 0;
  let skipped = 0;
  let copied = 0;
  for (const id of ids) {
    const dir = path.join(reportDir, 'images', encodeStoryId(id));
    mkdirSync(dir, { recursive: true });
    const rows = [
      `# ${id}`,
      '',
      '| pass | run | hash | recheck hash | error |',
      '| --- | --- | --- | --- | --- |',
    ];
    for (const [i, r] of runs.entries()) {
      const e = r.byStory.get(id);
      rows.push(
        `| ${i + 1} | ${r.runId} | ${e?.hash ?? '-'} | ${e?.recheck ?? '-'} | ${e?.error ? JSON.stringify(e.error).slice(0, 200) : '-'} |`,
      );
      if (!e?.hash) continue;
      const base = path.join(
        project,
        '.juxtapose/runs',
        r.runId,
        'images',
        `${encodeStoryId(id)}-current`,
      );
      for (const [src, name] of [
        [`${base}.webp`, `pass-${i + 1}-${hash8(e.hash)}.webp`],
        [`${base}.structure.json.gz`, `pass-${i + 1}-${hash8(e.hash)}.structure.json.gz`],
      ]) {
        if (!existsSync(src)) continue;
        const size = statSync(src).size;
        if (bytes + size > MAX_IMAGE_BYTES) {
          skipped++;
          continue;
        }
        copyFileSync(src, path.join(dir, name));
        bytes += size;
        copied++;
      }
    }
    const distinct = new Set(runs.map((r) => r.byStory.get(id)?.hash));
    rows.push('', `${distinct.size} distinct hash(es) across ${runs.length} passes.`, '');
    writeFileSync(path.join(dir, 'diff.md'), rows.join('\n'));
  }
  if (!ids.length) return '';
  return (
    `images: copied ${copied} files (${(bytes / 1048576).toFixed(1)} MB) for ${ids.length} stories` +
    (skipped
      ? `; SKIPPED ${skipped} files, the ${MAX_IMAGE_BYTES / 1048576} MB cap was reached`
      : '')
  );
}
const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
// Per-phase p50/p95 and total seconds from the results' `timings` (ms to 0.1).
// Empty when the CLI under test predates them or nothing was captured.
const PHASES = [
  'navigate',
  'freshRenderer',
  'render',
  'settle',
  'paint',
  'structure',
  'screenshot',
  'encode',
  'other',
];
function phaseStats(results) {
  const timed = results.filter((r) => r.timings);
  if (!timed.length) return undefined;
  const stats = {};
  for (const name of PHASES) {
    const v = timed.map((r) => r.timings[name] ?? 0).sort((a, b) => a - b);
    stats[name] = {
      p50: Math.round(percentile(v, 50)),
      p95: Math.round(percentile(v, 95)),
      totalSeconds: Math.round(v.reduce((a, b) => a + b, 0) / 100) / 10,
    };
  }
  return stats;
}
const phaseLine = (stats) =>
  'phases p50/p95 ms: ' +
  PHASES.map((n) => `${n} ${stats[n].p50}/${stats[n].p95}`).join(', ');

try {
  const runs = [];
  for (let i = 1; i <= passes; i++) {
    const state = mkdtempSync(path.join(tmpdir(), 'jux-field-state-'));
    const started = Date.now();
    try {
      const { stdout } = await jux(
        [
          'run',
          ...(investigate ? storyIds.flatMap((id) => ['--story', id]) : ['--all']),
          // Every story is new in a fresh state dir, so the stable-approve
          // recheck would capture each one twice per pass. The sweep compares
          // passes, not captures, so skip it and halve the captures per pass.
          // Investigation runs keep it, since its hash lands in diff.md.
          ...(investigate ? [] : ['--no-recheck']),
          '--json',
          '--no-daemon',
        ],
        state,
      );
      const wall = (Date.now() - started) / 1000;
      const { runId } = JSON.parse(stdout);
      const report = JSON.parse(
        readFileSync(path.join(project, '.juxtapose/runs', runId, 'report.json'), 'utf8'),
      );
      const ms = report.results.map((r) => r.durationMs).sort((a, b) => a - b);
      const errors = report.results.filter((r) => r.error).length;
      const errored = report.results.filter((r) => r.error).map((r) => r.storyId);
      runs.push({
        runId,
        wall,
        results: report.results.length,
        errored,
        phases: phaseStats(report.results),
        byStory: new Map(
          report.results.map((r) => [
            r.storyId,
            { hash: r.hash, error: r.error, recheck: r.unstable?.hashes?.[1] },
          ]),
        ),
      });
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
      const phases = runs.at(-1).phases;
      if (phases) say(`pass ${i}: ${phaseLine(phases)}`);
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

  if (flags['--report-dir']) {
    const toCopy = new Set(differing);
    for (const r of runs) for (const id of r.errored) toCopy.add(id);
    // Differs by hash between any pass and pass 1, even if `jux diff` agreed.
    for (const [id, first] of runs[0].byStory) {
      if (runs.some((r) => r.byStory.get(id)?.hash !== first.hash)) toCopy.add(id);
    }
    const note = copyImages(runs, [...toCopy].sort(), flags['--report-dir']);
    if (note) say(note);
  }

  const failures = [];
  let expected = { knownVariable: [], allowedErrors: [] };
  if (investigate) {
    say('investigation run (--stories): gate skipped');
  } else if (gate) {
    expected = {
      knownVariable: gate.knownVariable ?? [],
      allowedErrors: gate.allowedErrors ?? [],
    };
    const errored = [...new Set(runs.flatMap((r) => r.errored))];
    for (const id of errored.filter((id) => !expected.allowedErrors.includes(id))) {
      failures.push(`capture error not on the allowlist: ${id}`);
    }
    const unlisted = [...differing]
      .filter((id) => !expected.knownVariable.includes(id))
      .sort();
    const tolerated = gate.maxUnlistedDifferences ?? 0;
    if (unlisted.length > tolerated) {
      for (const id of unlisted) {
        failures.push(`differs across passes and is not known-variable: ${id}`);
      }
      failures.push(
        `${unlisted.length} unlisted differences exceed the tolerance of ${tolerated}`,
      );
    } else if (unlisted.length) {
      say(
        `note: ${unlisted.length} unlisted differences, within tolerance: ${unlisted.join(', ')}`,
      );
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
          passes: runs.map(({ runId, wall, results, errored, phases, byStory }) => ({
            runId,
            wall,
            results,
            errored,
            ...(phases ? { phases } : {}),
            // Per-story hashes only for an investigation, to keep result.json small.
            ...(investigate
              ? { hashes: Object.fromEntries([...byStory].map(([k, v]) => [k, v.hash])) }
              : {}),
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
