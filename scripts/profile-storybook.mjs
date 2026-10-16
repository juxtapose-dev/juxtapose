#!/usr/bin/env node
// Build once, then profile fixed captures against a fresh reference. No installs.
// node scripts/profile-storybook.mjs <buildDir> [measured passes per mode=5]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const buildDir = path.resolve(process.argv[2] ?? 'examples/storybook/storybook-profile');
const passes = Number(process.argv[3] ?? 5);
if (!Number.isInteger(passes) || passes < 3)
  throw new Error('Use at least 3 measured passes per mode');
const concurrency = Number(process.env.JUX_PROFILE_CONCURRENCY ?? 3);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
  throw new Error('JUX_PROFILE_CONCURRENCY must be an integer from 1 to 8');
const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'packages/cli/dist/index.js');
const out = mkdtempSync(path.join(os.tmpdir(), 'jux-controlled-profile-'));
const project = path.join(out, 'project');
mkdirSync(project);
const state = mkdtempSync(path.join(os.tmpdir(), 'jux-profile-state-'));
const digest = createHash('sha256');
function hashTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) hashTree(file);
    else if (entry.isFile())
      digest.update(path.relative(buildDir, file)).update(readFileSync(file));
  }
}
hashTree(buildDir);
const metadata = {
  commit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
  buildDir,
  buildHash: digest.digest('hex'),
  node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length,
  memoryBytes: os.totalmem(),
  concurrency,
  viewport: { width: 1280, height: 800 },
  daemon: false,
  passes,
};
writeFileSync(path.join(out, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log(out);
const samples = [];
async function capture(label, shared, measured) {
  writeFileSync(
    path.join(project, 'juxtapose.config.json'),
    JSON.stringify({
      platform: 'storybook',
      buildDir,
      concurrency,
      viewport: metadata.viewport,
      renderer: { shared, clearResourceCache: false },
      recheck: 'off',
    }),
  );
  const runRoot = path.join(project, '.juxtapose/runs');
  let previous;
  try {
    previous = new Set(readdirSync(runRoot));
  } catch {
    previous = new Set();
  }
  const loadBefore = os.loadavg();
  const start = performance.now();
  const result = await exec(process.execPath, [cli, 'run', '--all', '--no-daemon'], {
    cwd: project,
    env: { ...process.env, JUX_STATE_DIR: state, JUX_NO_DAEMON: '1' },
    maxBuffer: 64 * 1024 * 1024,
  }).catch((err) => {
    if (err.code === 1 && err.stdout) return err;
    throw err;
  });
  const wallMs = performance.now() - start;
  writeFileSync(path.join(out, `${label}.log`), result.stdout + result.stderr);
  const added = readdirSync(runRoot).filter(
    (dir) => !previous.has(dir) && existsSync(path.join(runRoot, dir, 'report.json')),
  );
  if (added.length !== 1) throw new Error(`Expected one report for ${label}`);
  const report = JSON.parse(readFileSync(path.join(runRoot, added[0], 'report.json')));
  writeFileSync(path.join(out, `${label}.json`), JSON.stringify(report));
  const sample = {
    label,
    shared,
    measured,
    wallMs,
    loadBefore,
    loadAfter: os.loadavg(),
    phases: result.stdout
      .split('\n')
      .find((line) => line.includes('capture ') && line.includes(' | ')),
    report,
  };
  samples.push(sample);
  console.log(
    `${label}: ${report.results.length} captures; ${Math.round(wallMs)}ms; ${JSON.stringify(report.summary)}`,
  );
  writeFileSync(path.join(out, 'samples.json'), JSON.stringify(samples, null, 2));
  return report;
}
const baseline = await capture('reference-fresh', false, false);
if (baseline.results.some((r) => r.error || !r.hash))
  throw new Error('Reference has missing captures');
writeFileSync(
  path.join(project, 'juxtapose.manifest.json'),
  JSON.stringify({
    version: 1,
    baselines: Object.fromEntries(
      baseline.results.map((r) => [
        r.storyId,
        {
          hash: r.hash,
          commit: baseline.commitSha,
          approvedBy: 'profile-reference',
          approvedAt: baseline.startedAt,
        },
      ]),
    ),
  }),
);
await capture('warmup-shared', true, false);
await capture('warmup-fresh', false, false);
for (let i = 1; i <= passes; i++) {
  for (const shared of i % 2 ? [true, false] : [false, true]) {
    await capture(`${shared ? 'shared' : 'fresh'}-${i}`, shared, true);
  }
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
};
const stats = (values) => ({
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  min: Math.min(...values),
  max: Math.max(...values),
});
const phaseNames = [
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
const summary = { metadata, referenceEnvironment: baseline.env, modes: {} };
for (const shared of [true, false]) {
  const runs = samples.filter((s) => s.measured && s.shared === shared);
  const results = runs.flatMap((s) => s.report.results);
  const ordinary = results.filter((r) => r.timings && !r.rendererRetry);
  const phaseTotals = Object.fromEntries(
    phaseNames.map((key) => [
      key,
      stats(
        runs.map((s) =>
          s.report.results
            .filter((r) => r.timings && !r.rendererRetry)
            .reduce((sum, r) => sum + (r.timings[key] ?? 0), 0),
        ),
      ),
    ]),
  );
  const workloads = {};
  for (const family of [
    'forms',
    'tables',
    'cards',
    'typography',
    'charts',
    'images',
    'nested',
    'async',
  ]) {
    const group = ordinary.filter((r) => r.storyId.startsWith(`profile--${family}-`));
    workloads[family] = {
      captures: group.length,
      durationMs: stats(group.map((r) => r.durationMs)),
      phases: Object.fromEntries(
        phaseNames.map((key) => [key, stats(group.map((r) => r.timings[key] ?? 0))]),
      ),
    };
  }
  summary.modes[shared ? 'shared' : 'fresh'] = {
    runs: runs.length,
    capturesPerRun: runs.map((s) => s.report.results.length),
    wallMs: stats(runs.map((s) => s.wallMs)),
    runMs: stats(runs.map((s) => s.report.durationMs)),
    outsideRunMs: stats(runs.map((s) => s.wallMs - s.report.durationMs)),
    failures: results
      .filter((r) => r.status !== 'pass')
      .map((r) => ({ storyId: r.storyId, status: r.status, error: r.error })),
    retries: results.filter((r) => r.rendererRetry).length,
    phases: Object.fromEntries(
      phaseNames.map((key) => [key, stats(ordinary.map((r) => r.timings[key] ?? 0))]),
    ),
    phaseTotalMsPerRun: phaseTotals,
    workloads,
  };
}
writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
const lines = [
  '# Controlled Storybook profile',
  '',
  `Build SHA-256: ${metadata.buildHash}`,
  '',
  'Five measured passes per mode by default, alternating mode order; one fresh reference and one excluded warm-up per mode. New browser per run, concurrency recorded in metadata, fixed build and local resources. Phase sums are worker time, not elapsed wall time. Recovery captures are excluded from phase distributions because result timings describe only the final capture. No intentional-change/diff workload is included.',
  '',
  '| Mode | Captures/run | Wall median (range), s | Run median, s | Failures | Retries |',
  '| --- | --- | --- | --- | --- | --- |',
];
for (const [name, m] of Object.entries(summary.modes))
  lines.push(
    `| ${name} | ${m.capturesPerRun.join('/')} | ${(m.wallMs.median / 1000).toFixed(2)} (${(m.wallMs.min / 1000).toFixed(2)}–${(m.wallMs.max / 1000).toFixed(2)}) | ${(m.runMs.median / 1000).toFixed(2)} | ${m.failures.length} | ${m.retries} |`,
  );
for (const [name, m] of Object.entries(summary.modes)) {
  lines.push(
    '',
    `## ${name}: phase time`,
    '',
    '| Phase | Per capture p50/p95 ms | Median summed worker seconds/run |',
    '| --- | --- | --- |',
  );
  for (const [key, stat] of Object.entries(m.phases))
    lines.push(
      `| ${key} | ${stat.median.toFixed(1)} / ${stat.p95.toFixed(1)} | ${(m.phaseTotalMsPerRun[key].median / 1000).toFixed(2)} |`,
    );
}
writeFileSync(path.join(out, 'summary.md'), lines.join('\n') + '\n');
console.log(`Report: ${out}/summary.md`);
if (Object.values(summary.modes).some((m) => m.failures.length)) process.exitCode = 1;
