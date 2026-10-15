#!/usr/bin/env node
// node scripts/compare-pipeline.mjs BASELINE_CLI CANDIDATE_CLI BUILD [passes=5] [--pixel-parity]
// JUX_PROFILE_CONCURRENCY=1..8 overrides the default 3.
// JUX_PROFILE_CANDIDATE_CONCURRENCY changes only candidate warmup/measured runs;
// both fresh references retain the baseline concurrency.
// Requires built CLIs and the controlled 120-capture Storybook. Never installs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const args = process.argv.slice(2);
const pixels = args.includes('--pixel-parity');
const positional = args.filter((a) => a !== '--pixel-parity');
if (
  positional.length < 3 ||
  positional.length > 4 ||
  positional.some((a) => a.startsWith('--'))
)
  throw new Error(
    'Usage: compare-pipeline.mjs BASELINE_CLI CANDIDATE_CLI BUILD [passes>=3] [--pixel-parity]',
  );
const [baselineCLI, candidateCLI, buildDir] = positional
  .slice(0, 3)
  .map((p) => path.resolve(p));
const passes = Number(positional[3] ?? 5);
if (!Number.isInteger(passes) || passes < 3)
  throw new Error('Use at least 3 measured passes');
const concurrency = Number(process.env.JUX_PROFILE_CONCURRENCY ?? 3);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
  throw new Error('JUX_PROFILE_CONCURRENCY must be an integer from 1 to 8');
const candidateConcurrency = Number(
  process.env.JUX_PROFILE_CANDIDATE_CONCURRENCY ?? concurrency,
);
if (
  !Number.isInteger(candidateConcurrency) ||
  candidateConcurrency < 1 ||
  candidateConcurrency > 8
)
  throw new Error('JUX_PROFILE_CANDIDATE_CONCURRENCY must be an integer from 1 to 8');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const cliHashes = [baselineCLI, candidateCLI].map((p) => sha(readFileSync(p)));
const digest = createHash('sha256');
function hashTree(dir, hash = digest, relativeRoot = buildDir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) hashTree(f, hash, relativeRoot);
    else if (e.isFile())
      hash
        .update(path.relative(relativeRoot, f))
        .update('\0')
        .update(readFileSync(f))
        .update('\0');
  }
}
hashTree(buildDir);
async function provenance(cli) {
  const cwd = path.dirname(cli);
  let repoRoot;
  try {
    repoRoot = (
      await exec('git', ['rev-parse', '--show-toplevel'], { cwd })
    ).stdout.trim();
  } catch {
    return {
      repoRoot: null,
      gitHead: null,
      dirty: null,
      builtPackagesHash: null,
      unavailable: 'CLI is outside a git checkout',
    };
  }
  const gitHead = (
    await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
  ).stdout.trim();
  const workingTreeStatus = (
    await exec('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
      cwd: repoRoot,
    })
  ).stdout;
  const combined = createHash('sha256');
  const builtPackages = {};
  const missingBuiltPackages = [];
  for (const name of ['core', 'cli', 'adapter-storybook', 'adapter-ladle']) {
    const dir = path.join(repoRoot, 'packages', name, 'dist');
    if (!existsSync(dir)) {
      missingBuiltPackages.push(name);
      continue;
    }
    const packageHash = createHash('sha256');
    hashTree(dir, packageHash, dir);
    builtPackages[name] = packageHash.digest('hex');
    combined.update(name).update('\0').update(builtPackages[name]).update('\0');
  }
  return {
    repoRoot,
    gitHead,
    dirty: workingTreeStatus.length > 0,
    workingTreeStatus,
    builtPackages,
    missingBuiltPackages,
    builtPackagesHash: combined.digest('hex'),
    lockfileHash: existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))
      ? sha(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml')))
      : null,
  };
}
const provenanceByArm = await Promise.all([baselineCLI, candidateCLI].map(provenance));
const expected = [
  'forms',
  'tables',
  'cards',
  'typography',
  'charts',
  'images',
  'nested',
  'async',
]
  .flatMap((f) =>
    ['small', 'medium', 'large'].flatMap((s) =>
      ['', '__dark', '__mobile', '__mobile-dark', '__tablet'].map(
        (v) => `profile--${f}-${s}${v}`,
      ),
    ),
  )
  .sort();
const out = mkdtempSync(path.join(os.tmpdir(), 'jux-pipeline-comparison-'));
const save = (name, value) =>
  writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
console.log(out);
const arms = Object.fromEntries(
  ['baseline', 'candidate'].map((name, i) => {
    const project = path.join(out, name);
    mkdirSync(project);
    const state = path.join(project, 'state');
    mkdirSync(state);
    return [
      name,
      {
        cli: [baselineCLI, candidateCLI][i],
        cliHash: cliHashes[i],
        concurrency: i ? candidateConcurrency : concurrency,
        provenance: provenanceByArm[i],
        project,
        state,
      },
    ];
  }),
);
const metadata = {
  buildDir,
  buildHash: digest.digest('hex'),
  passes,
  pixelParityRequested: pixels,
  node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length,
  memoryBytes: os.totalmem(),
  concurrency,
  viewport: { width: 1280, height: 800 },
  daemon: false,
  recheck: 'off',
  arms,
};
save('metadata.json', metadata);
const samples = [],
  failures = [];
function validateKeys(report, label) {
  const ids = report.results.map((r) => r.storyId).sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected))
    throw new Error(`${label}: expected exactly the controlled 120 capture keys`);
}
async function capture(name, label, reference = false, measured = false) {
  const arm = arms[name];
  writeFileSync(
    path.join(arm.project, 'juxtapose.config.json'),
    JSON.stringify({
      platform: 'storybook',
      buildDir,
      concurrency: reference ? concurrency : arm.concurrency,
      viewport: metadata.viewport,
      renderer: { shared: !reference, clearResourceCache: false },
      recheck: 'off',
    }),
  );
  const runs = path.join(arm.project, '.juxtapose/runs');
  const previous = new Set(existsSync(runs) ? readdirSync(runs) : []);
  const loadBefore = os.loadavg(),
    start = performance.now();
  const result = await exec(process.execPath, [arm.cli, 'run', '--all', '--no-daemon'], {
    cwd: arm.project,
    env: { ...process.env, JUX_STATE_DIR: arm.state, JUX_NO_DAEMON: '1' },
    maxBuffer: 64 * 1024 * 1024,
  }).catch((err) => err);
  const wallMs = performance.now() - start;
  writeFileSync(
    path.join(out, `${name}-${label}.log`),
    (result.stdout ?? '') +
      (result.stderr ?? '') +
      (result instanceof Error ? `\nProcess error: ${result.message}\n` : ''),
  );
  const added = (existsSync(runs) ? readdirSync(runs) : []).filter(
    (d) => !previous.has(d) && existsSync(path.join(runs, d, 'report.json')),
  );
  if (added.length !== 1)
    throw new Error(`${name}-${label}: expected one report; see retained log`);
  const runDir = path.join(runs, added[0]);
  const report = JSON.parse(readFileSync(path.join(runDir, 'report.json')));
  const sample = {
    arm: name,
    label,
    measured,
    reference,
    wallMs,
    loadBefore,
    loadAfter: os.loadavg(),
    runDir,
    exitCode: result instanceof Error ? (result.code ?? null) : 0,
    signal: result.signal ?? null,
    report,
  };
  samples.push(sample);
  save('samples.json', samples);
  save(`${name}-${label}.json`, report);
  validateKeys(report, `${name}-${label}`);
  for (const r of report.results) {
    const bad = reference
      ? r.error || !r.hash || r.status !== 'new'
      : r.status !== 'pass' ||
        r.error ||
        r.unstable ||
        r.hash !== arm.reference[r.storyId];
    if (bad)
      failures.push({
        arm: name,
        label,
        storyId: r.storyId,
        status: r.status,
        error: r.error,
        unstable: r.unstable,
        hash: r.hash,
        expectedHash: arm.reference?.[r.storyId],
      });
  }
  if (
    result instanceof Error &&
    (!reference || result.signal || result.killed || result.code !== 1)
  )
    failures.push({ arm: name, label, error: result.message });
  console.log(
    `${name}-${label}: ${Math.round(wallMs)}ms ${JSON.stringify(report.summary)}`,
  );
  if (reference && failures.length) throw new Error('Invalid fresh reference');
  return sample;
}
let fatal;
try {
  for (const name of ['baseline', 'candidate']) {
    const s = await capture(name, 'reference', true);
    arms[name].reference = Object.fromEntries(
      s.report.results.map((r) => [r.storyId, r.hash]),
    );
    writeFileSync(
      path.join(arms[name].project, 'juxtapose.manifest.json'),
      JSON.stringify({
        version: 1,
        baselines: Object.fromEntries(
          s.report.results.map((r) => [
            r.storyId,
            {
              hash: r.hash,
              commit: s.report.commitSha,
              approvedBy: 'pipeline-profile-reference',
              approvedAt: s.report.startedAt,
            },
          ]),
        ),
      }),
    );
    await capture(name, 'warmup');
  }
  for (let i = 1; i <= passes; i++)
    for (const name of i % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'])
      await capture(name, `pass-${i}`, false, true);
  if (pixels) {
    const root = path.resolve(import.meta.dirname, '..');
    const require = createRequire(path.join(root, 'packages/core/package.json'));
    const sharp = require('sharp');
    const a = samples.find((s) => s.arm === 'baseline' && s.measured),
      b = samples.find((s) => s.arm === 'candidate' && s.measured);
    const checks = [];
    for (const id of expected) {
      // Controlled IDs contain only filename-safe ASCII, so encodeStoryId is identity.
      const bytes = [a, b].map((s) =>
        readFileSync(path.join(s.runDir, 'images', `${id}-current.webp`)),
      );
      for (let i = 0; i < 2; i++)
        if (sha(bytes[i]) !== arms[i ? 'candidate' : 'baseline'].reference[id])
          throw new Error(`Artifact hash mismatch: ${id}`);
      const [x, y] = await Promise.all(
        bytes.map((image) =>
          sharp(image, { ignoreIcc: true })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true }),
        ),
      );
      const equal =
        x.info.width === y.info.width &&
        x.info.height === y.info.height &&
        x.info.channels === y.info.channels &&
        x.data.equals(y.data);
      checks.push({ storyId: id, equal, baseline: x.info, candidate: y.info });
      if (!equal)
        failures.push({ storyId: id, error: 'Cross-arm decoded pixel mismatch' });
    }
    save('pixel-parity.json', {
      method: 'Sharp raw RGBA, ignoreIcc:true; exact dimensions and channels',
      checks,
    });
  }
} catch (err) {
  fatal = String(err.stack ?? err);
  failures.push({ error: fatal });
}
const stats = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
};
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
const summary = {
  metadata,
  failures,
  arms: {},
  note: 'Phase percentages are fractions of summed worker phase time, not elapsed wall time. Retry results excluded from phase accounting; raw reports retained.',
};
for (const name of ['baseline', 'candidate']) {
  const runs = samples.filter((s) => s.arm === name && s.measured),
    results = runs.flatMap((s) => s.report.results);
  const ordinary = results.filter((r) => r.timings && !r.rendererRetry);
  const total = ordinary.reduce(
    (sum, r) => sum + phaseNames.reduce((n, k) => n + (r.timings[k] ?? 0), 0),
    0,
  );
  summary.arms[name] = {
    runs: runs.length,
    captures: results.length,
    retries: results.filter((r) => r.rendererRetry).length,
    phaseCaptures: ordinary.length,
    wallMs: stats(runs.map((s) => s.wallMs)),
    runMs: stats(runs.map((s) => s.report.durationMs)),
    outsideRunMs: stats(runs.map((s) => s.wallMs - s.report.durationMs)),
    phases: Object.fromEntries(
      phaseNames.map((k) => {
        const ms = ordinary.reduce((sum, r) => sum + (r.timings[k] ?? 0), 0);
        return [
          k,
          {
            perCaptureMs: stats(ordinary.map((r) => r.timings[k] ?? 0)),
            summedWorkerMs: ms,
            workerTimePercent: total ? (100 * ms) / total : 0,
          },
        ];
      }),
    ),
  };
}
if (summary.arms.baseline.wallMs && summary.arms.candidate.wallMs)
  summary.wallMedianChangePercent =
    100 *
    (summary.arms.candidate.wallMs.median / summary.arms.baseline.wallMs.median - 1);
save('summary.json', summary);
const lines = [
  '# Pipeline comparison',
  '',
  summary.note,
  '',
  '| Arm | Runs | Wall mean / median ms | Run mean ms | Retries |',
  '| --- | ---: | ---: | ---: | ---: |',
];
for (const [name, a] of Object.entries(summary.arms))
  lines.push(
    `| ${name} | ${a.runs} | ${a.wallMs?.mean.toFixed(1) ?? 'n/a'} / ${a.wallMs?.median.toFixed(1) ?? 'n/a'} | ${a.runMs?.mean.toFixed(1) ?? 'n/a'} | ${a.retries} |`,
  );
lines.push(
  '',
  '| Phase | Baseline mean ms/capture | Candidate mean ms/capture | Baseline worker % | Candidate worker % |',
  '| --- | ---: | ---: | ---: | ---: |',
);
for (const k of phaseNames) {
  const a = summary.arms.baseline.phases[k],
    b = summary.arms.candidate.phases[k];
  lines.push(
    `| ${k} | ${a.perCaptureMs?.mean.toFixed(2) ?? 'n/a'} | ${b.perCaptureMs?.mean.toFixed(2) ?? 'n/a'} | ${a.workerTimePercent.toFixed(1)} | ${b.workerTimePercent.toFixed(1)} |`,
  );
}
lines.push(
  '',
  `Failures: ${failures.length}. Cross-arm pixel parity: ${pixels ? 'requested; see pixel-parity.json' : 'not requested'}.`,
  '',
  `Evidence: ${out}`,
);
writeFileSync(path.join(out, 'summary.md'), lines.join('\n') + '\n');
console.log(`Report: ${out}/summary.md`);
if (fatal) console.error(fatal);
if (failures.length) process.exitCode = 1;
