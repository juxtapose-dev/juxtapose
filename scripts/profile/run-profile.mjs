#!/usr/bin/env node
// Profile `jux run` over a fixed, evenly-strided sample of a static Storybook.
//
// Usage: node scripts/profile/run-profile.mjs <buildDir> --out <dir>
//          [--stories 200] [--concurrency 3,8] [--repeats 1] [--cpu-prof]
//
// Per (concurrency, repeat) it runs one `jux run --story ...` with
// scripts/profile/preload.mjs (event loop, fs, sync work, CDP round trips,
// sharp) and optionally --cpu-prof, then writes <out>/summary.json with:
// per-phase p50/p95 from report.json `timings`, pool slot utilization, the
// preload buckets, and the top self-time functions of the jux process.
// Nothing is installed or written inside the repo; state goes to a temp dir.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'packages/cli/dist/index.js');
const preload = path.join(root, 'scripts/profile/preload.mjs');
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const buildDir = path.resolve(argv.find((a) => !a.startsWith('--')) ?? '');
const outDir = path.resolve(opt('--out', 'profile-out'));
const nStories = Number(opt('--stories', '200'));
const concs = opt('--concurrency', '3,8').split(',').map(Number);
const repeats = Number(opt('--repeats', '1'));
const cpuProf = argv.includes('--cpu-prof');
// Each variant is one way of running the same sample. `env` and `chromeFlags`
// change the browser or the capture; `jux` adds CLI flags; `conc` overrides
// the concurrency. Hash-neutral ones must hash identically to `base`.
const VARIANTS = {
  base: {},
  'png-speed': { env: { JUX_EXP_SHOT: 'png-speed' } },
  'chrome-webp': { env: { JUX_EXP_SHOT: 'webp' } },
  'chrome-webp-noicc': { env: { JUX_EXP_SHOT: 'webp-noicc' } },
  'no-fresh-renderer': { jux: ['--no-fresh-renderer'] },
  'v8-cache-none': { chromeFlags: ['--v8-cache-options=none'] },
  'js-no-opt': { chromeFlags: ['--js-flags=--no-opt'] },
  'js-max-lazy': { chromeFlags: ['--js-flags=--max-lazy'] },
  'sharp-conc1': { env: { JUX_PRELOAD_SHARP_CONC: '1' } },
  'sharp-conc2': { env: { JUX_PRELOAD_SHARP_CONC: '2' } },
  'uv-threads-8': { env: { UV_THREADPOOL_SIZE: '8' } },
  c2: { conc: 2 },
  c4: { conc: 4 },
  c6: { conc: 6 },
};
const variantNames = opt('--variants', 'base').split(',');
for (const v of variantNames)
  if (!VARIANTS[v]) {
    console.error(`unknown variant ${v}; known: ${Object.keys(VARIANTS).join(', ')}`);
    process.exit(2);
  }
const realChrome = spawnSync('node', [cli, 'browser', 'path'], {
  encoding: 'utf8',
}).stdout.trim();
/** A shell wrapper that appends flags: --chrome takes a path, not arguments. */
function chromeWrapper(flags) {
  const f = path.join(outDir, `chrome-${flags.join('_').replace(/[^\w.-]/g, '')}.sh`);
  writeFileSync(f, `#!/bin/sh\nexec "${realChrome}" "$@" ${flags.join(' ')}\n`, {
    mode: 0o755,
  });
  return f;
}
if (!existsSync(path.join(buildDir, 'index.json'))) {
  console.error('usage: run-profile.mjs <storybook build dir> --out <dir>');
  process.exit(2);
}

const index = JSON.parse(readFileSync(path.join(buildDir, 'index.json'), 'utf8'));
const ids = Object.values(index.entries)
  .filter((e) => e.type !== 'docs')
  .map((e) => e.id)
  .sort();
const n = Math.min(nStories, ids.length);
const sample = Array.from({ length: n }, (_, i) => ids[Math.floor((i * ids.length) / n)]);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'sample.json'), JSON.stringify(sample));

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
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
const r1 = (v) => Math.round(v * 10) / 10;

/** Top self-time functions of a .cpuprofile (V8 sampling profile). */
function topSelf(file, limit = 20) {
  const prof = JSON.parse(readFileSync(file, 'utf8'));
  const self = new Map();
  const byId = new Map(prof.nodes.map((nd) => [nd.id, nd]));
  const dt = prof.timeDeltas;
  for (let i = 0; i < prof.samples.length; i++) {
    self.set(prof.samples[i], (self.get(prof.samples[i]) ?? 0) + (dt[i] ?? 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const agg = new Map();
  for (const [id, us] of self) {
    const cf = byId.get(id).callFrame;
    const key = `${cf.functionName || '(anonymous)'} ${path
      .relative(root, cf.url.replace('file://', '') || '')
      .replace(/^(\.\.\/)+/, '')}:${cf.lineNumber + 1}`;
    agg.set(key, (agg.get(key) ?? 0) + us);
  }
  return {
    totalMs: Math.round(total / 1000),
    top: [...agg]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([fn, us]) => ({
        fn,
        selfMs: Math.round(us / 1000),
        pct: Math.round((us / total) * 1000) / 10,
      })),
  };
}

const runs = [];
// Repeats outermost and variants interleaved inside, so drift on a shared host
// hits every variant alike.
const plan = [];
for (let rep = 1; rep <= repeats; rep++)
  for (const baseConc of concs)
    for (const vname of variantNames) plan.push({ rep, baseConc, vname });
{
  for (const { rep, baseConc, vname } of plan) {
    const variant = VARIANTS[vname];
    const conc = variant.conc ?? baseConc;
    const tag = `${vname}-c${conc}-r${rep}`;
    const dir = path.join(outDir, tag);
    mkdirSync(dir, { recursive: true });
    const project = mkdtempSync(path.join(os.tmpdir(), 'jux-prof-project-'));
    const state = mkdtempSync(path.join(os.tmpdir(), 'jux-prof-state-'));
    writeFileSync(
      path.join(project, 'juxtapose.config.json'),
      JSON.stringify({ platform: 'storybook', buildDir }),
    );
    const nodeArgs = [
      '--import',
      preload,
      ...(cpuProf ? ['--cpu-prof', '--cpu-prof-dir', path.join(dir, 'cpuprof')] : []),
      cli,
      'run',
      ...sample.flatMap((id) => ['--story', id]),
      '--no-recheck',
      '--json',
      '--no-daemon',
      '--concurrency',
      String(conc),
      ...(variant.jux ?? []),
      ...(variant.chromeFlags ? ['--chrome', chromeWrapper(variant.chromeFlags)] : []),
      '--project',
      project,
    ];
    const load = os.loadavg();
    const t0 = Date.now();
    const res = spawnSync('node', nodeArgs, {
      env: {
        ...process.env,
        ...(variant.env ?? {}),
        JUX_STATE_DIR: state,
        JUX_PROFILE_OUT: dir,
      },
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'utf8',
    });
    const wallS = (Date.now() - t0) / 1000;
    let summary = {
      tag,
      variant: vname,
      concurrency: conc,
      repeat: rep,
      wallS,
      load1: load[0],
    };
    try {
      const { runId } = JSON.parse(res.stdout);
      const report = JSON.parse(
        readFileSync(path.join(project, '.juxtapose/runs', runId, 'report.json'), 'utf8'),
      );
      const timed = report.results.filter((r) => r.timings);
      const phases = Object.fromEntries(
        PHASES.map((p) => {
          const v = timed.map((r) => r.timings[p] ?? 0);
          return [
            p,
            {
              p50: r1(pct(v, 50)),
              p95: r1(pct(v, 95)),
              sumS: r1(v.reduce((a, b) => a + b, 0) / 1000),
            },
          ];
        }),
      );
      const dur = report.results.map((r) => r.durationMs);
      const busyS = dur.reduce((a, b) => a + b, 0) / 1000;
      const pre = JSON.parse(readFileSync(path.join(dir, 'preload.json'), 'utf8'));
      // Slot utilization: story-seconds spent capturing against slot-seconds
      // available between the first browser being up and the last result.
      const launchS = (pre.buckets['browser.launch']?.totalMs ?? 0) / 1000;
      const slotS = Math.max(0.001, (wallS - launchS) * conc);
      summary = {
        ...summary,
        results: report.results.length,
        errors: report.results.filter((r) => r.error).length,
        durationMs: {
          p50: pct(dur, 50),
          p95: pct(dur, 95),
          mean: r1((busyS * 1000) / dur.length),
        },
        phases,
        hashes: Object.fromEntries(
          report.results.map((r) => [r.storyId, r.hash ?? null]),
        ),
        storySeconds: r1(busyS),
        slotUtilization: Math.round((busyS / slotS) * 1000) / 1000,
        nonStoryWallS: r1(wallS - busyS / conc),
        preload: pre,
      };
      if (cpuProf) {
        const dirp = path.join(dir, 'cpuprof');
        const files = existsSync(dirp)
          ? readdirSync(dirp).filter((f) => f.endsWith('.cpuprofile'))
          : [];
        if (files.length) summary.cpuProfile = topSelf(path.join(dirp, files[0]));
      }
    } catch (e) {
      summary.error = String(e?.message ?? e) + '\n' + (res.stderr ?? '').slice(-600);
    }
    runs.push(summary);
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
    console.log(
      `${tag}: wall ${wallS.toFixed(1)} s, load1 ${load[0].toFixed(1)}, ` +
        (summary.error
          ? `ERROR ${summary.error.slice(0, 200)}`
          : `p50 ${summary.durationMs.p50} ms, slot util ${summary.slotUtilization}, loop util ${summary.preload.eventLoop.utilization}`),
    );
    rmSync(project, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}
writeFileSync(
  path.join(outDir, 'summary.json'),
  JSON.stringify(
    {
      host: {
        cpus: os.cpus().length,
        model: os.cpus()[0]?.model,
        platform: process.platform,
      },
      runs,
    },
    null,
    1,
  ),
);
