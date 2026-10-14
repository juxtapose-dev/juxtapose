#!/usr/bin/env node
/* global requestAnimationFrame */
// SPIKE (#145): measurements for frame-controlled capture. Not part of CI.
//
//   probe <out.json>                     does beginFrame work here, and how fast
//   run <projectDir> <runs> <out.json>   `jux run --all` N times (fresh launch)
//   snap <runs> <out.json>               corpus pages through `jux snap --as-prefix`
//   fixtures <runs> <out.json>           #120 and #136 vitest fixtures N times
//   summary <out.md> <file.json>...      one table across every arm
//
// The arm is whatever env the caller sets (JUX_BEGIN_FRAME, JUX_SPIKE_*); it
// is recorded in each output file.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(ROOT, 'packages/cli/dist/index.js');
const arm = {
  label: process.env.SPIKE_ARM ?? 'unlabelled',
  env: Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /^JUX_(BEGIN_FRAME|SPIKE_)/.test(k)),
  ),
};
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'probe') await probe(args[0]);
else if (cmd === 'run') await runs(args[0], Number(args[1]), args[2]);
else if (cmd === 'snap') await snaps(Number(args[0]), args[1]);
else if (cmd === 'fixtures') await fixtures(Number(args[0]), args[1]);
else if (cmd === 'summary') summary(args[0], args.slice(1));
else {
  console.error('usage: see the header');
  process.exit(2);
}

async function probe(out) {
  const { Browser } = await import(
    path.join(ROOT, 'packages/core/dist/browser/index.js')
  );
  const exe = (await run('node', [CLI, 'browser', 'path'])).stdout.trim();
  const result = { arm, exe, platform: process.platform };
  const b = await Browser.launch({ executablePath: exe });
  try {
    const ctx = await b.newContext({ viewport: { width: 400, height: 300 } });
    const page = await ctx.newPage();
    await page.goto(
      'data:text/html,<body style="margin:0"><div style="width:100px;height:50px;background:%2300f;border-radius:7px"></div>',
    );
    const t = [];
    const shots = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      shots.push(sha(await page.screenshot()));
      t.push(performance.now() - t0);
    }
    const raf = await page.evaluate(
      () =>
        new Promise((r) => {
          const t0 = performance.now();
          let n = 0;
          const f = () =>
            ++n === 10 ? r(performance.now() - t0) : requestAnimationFrame(f);
          requestAnimationFrame(f);
        }),
    );
    Object.assign(result, {
      ok: true,
      pump: page.pump ? { ...page.pump.stats } : null,
      screenshotMs: t.map((x) => +x.toFixed(1)),
      distinctShots: new Set(shots).size,
      tenRafMs: +raf.toFixed(1),
    });
    await ctx.close();
  } catch (e) {
    result.ok = false;
    result.error = String(e?.message ?? e);
  } finally {
    await b.close();
  }
  console.log(JSON.stringify(result));
  writeFileSync(out, JSON.stringify(result, null, 1));
}

async function runs(projectDir, n, out) {
  const env = { ...process.env, JUX_NO_DAEMON: '1' };
  const perRun = [];
  for (let i = 0; i < n; i++) {
    const runsRoot = path.join(projectDir, '.juxtapose', 'runs');
    const before = new Set(existsSync(runsRoot) ? readdirSync(runsRoot) : []);
    const t0 = Date.now();
    const res = await run(
      'node',
      [CLI, 'run', '--all', '--json', '--project', projectDir],
      {
        cwd: projectDir,
        env,
        maxBuffer: 1 << 28,
      },
    ).catch((e) => e);
    const wallMs = Date.now() - t0;
    const dir = readdirSync(runsRoot)
      .filter((d) => !before.has(d) && existsSync(path.join(runsRoot, d, 'report.json')))
      .sort()
      .at(-1);
    if (!dir) {
      console.error(
        `run ${i}: no run dir; ${String(res.stderr ?? res.message).slice(-800)}`,
      );
      perRun.push({ wallMs, stories: {}, error: true });
      continue;
    }
    const full = path.join(runsRoot, dir);
    const report = JSON.parse(readFileSync(path.join(full, 'report.json'), 'utf8'));
    const stories = {};
    for (const r of report.results) {
      const f = path.join(full, 'images', `${r.storyId}-current.webp`);
      stories[r.storyId] = {
        h: existsSync(f) ? sha(await readFile(f)) : null,
        ms: r.durationMs,
        ...(r.settle ? { settle: r.settle.status } : {}),
        ...(r.error ? { error: r.error.slice(0, 200) } : {}),
      };
    }
    perRun.push({ wallMs, stories });
    console.error(
      `  ${arm.label} run ${i + 1}/${n}: ${report.results.length} stories, ${wallMs} ms`,
    );
  }
  writeFileSync(out, JSON.stringify({ kind: 'run', arm, projectDir, perRun }));
}

async function snaps(n, out) {
  const { startCorpusServer } = await import(
    path.join(ROOT, 'scripts/structural-corpus/server.mjs')
  );
  const { OPERATORS } = await import(
    path.join(ROOT, 'scripts/structural-corpus/page.mjs')
  );
  const server = await startCorpusServer();
  const urls = OPERATORS.map((o) => `${server.url}/op/${o.name}`);
  const proj = mkdtempSync(path.join(tmpdir(), 'jux-spike-snap-'));
  const env = { ...process.env, JUX_NO_DAEMON: '1' };
  const perRun = [];
  for (let i = 0; i < n; i++) {
    const order = i % 2 ? [...urls].reverse() : urls;
    const prefix = `run${i}`;
    const t0 = Date.now();
    const res = await run(
      'node',
      [CLI, 'snap', ...order, '--as-prefix', prefix, '--json', '--project', proj],
      { cwd: proj, env, maxBuffer: 1 << 28 },
    ).catch((e) => e);
    const wallMs = Date.now() - t0;
    let parsed = null;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {}
    const stories = {};
    for (const s of parsed?.snaps ?? []) {
      const id = s.name.slice(prefix.length + 1);
      stories[id] = s.error
        ? { h: null, error: String(s.error).slice(0, 200) }
        : { h: sha(await readFile(s.image)), ms: s.durationMs };
    }
    if (!parsed)
      console.error(`snap ${i}: ${String(res.stderr ?? res.message).slice(-800)}`);
    perRun.push({ wallMs, stories });
  }
  server.close();
  writeFileSync(out, JSON.stringify({ kind: 'snap', arm, perRun }));
}

async function fixtures(n, out) {
  const files = [
    'packages/core/src/browser/page.test.ts',
    'packages/core/src/capture/reraster-capture.test.ts',
  ];
  const tally = {};
  for (let i = 0; i < n; i++) {
    const json = path.join(tmpdir(), `spike-vitest-${process.pid}-${i}.json`);
    await run(
      'pnpm',
      ['exec', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${json}`],
      { cwd: ROOT, env: process.env, maxBuffer: 1 << 26 },
    ).catch(() => {});
    if (!existsSync(json)) {
      tally['(vitest crashed)'] = (tally['(vitest crashed)'] ?? 0) + 1;
      continue;
    }
    const r = JSON.parse(readFileSync(json, 'utf8'));
    for (const f of r.testResults)
      for (const t of f.assertionResults) {
        const k = `${path.basename(f.name)} :: ${t.title}`;
        tally[k] ??= { passed: 0, failed: 0, msg: undefined };
        if (t.status === 'passed') tally[k].passed++;
        else if (t.status === 'failed') {
          tally[k].failed++;
          tally[k].msg ??= (t.failureMessages?.[0] ?? '').split('\n')[0].slice(0, 160);
        }
      }
  }
  writeFileSync(out, JSON.stringify({ kind: 'fixtures', arm, n, tally }));
}

function q(sorted, p) {
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    : NaN;
}

/** Per arm: stable stories (one hash over every run), identity with the first arm, cost. */
function summary(out, files) {
  const data = files.map((f) => ({
    file: path.basename(f),
    ...JSON.parse(readFileSync(f, 'utf8')),
  }));
  const lines = [];
  const groups = new Map();
  for (const d of data) {
    const key =
      d.kind === 'fixtures' ? 'fixtures' : `${d.kind}:${d.projectDir ?? 'corpus'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  for (const [key, arms] of groups) {
    lines.push(`\n### ${key}\n`);
    if (key === 'fixtures') {
      for (const a of arms) {
        lines.push(
          `**${a.arm.label}** (${a.n} vitest runs, env ${JSON.stringify(a.arm.env)})\n`,
        );
        for (const [t, v] of Object.entries(a.tally))
          if (/repainting|marquee|crashed/.test(t))
            lines.push(
              `- ${t}: pass ${v.passed ?? '-'} / fail ${v.failed ?? v}${v.msg ? ` — ${v.msg}` : ''}`,
            );
        const others = Object.entries(a.tally).filter(
          ([t]) => !/repainting|marquee|crashed/.test(t),
        );
        const bad = others.filter(([, v]) => v.failed);
        lines.push(
          `- other tests in those files: ${others.length}, with failures: ${bad.map(([t, v]) => `${t} (${v.failed}: ${v.msg})`).join('; ') || 'none'}\n`,
        );
      }
      continue;
    }
    const ref = arms[0];
    const refHash = new Map();
    for (const [id, s] of Object.entries(ref.perRun[0]?.stories ?? {}))
      refHash.set(id, s.h);
    lines.push(
      '| arm | runs | stories | stable (1 hash, all runs) | = first arm (run 1) | settle flagged | errors | p50 ms | p95 ms | wall ms (median) |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const a of arms) {
      const ids = new Set(a.perRun.flatMap((r) => Object.keys(r.stories)));
      let stable = 0,
        same = 0,
        flagged = 0,
        errors = 0;
      const unstable = [];
      for (const id of ids) {
        const hs = new Set(a.perRun.map((r) => r.stories[id]?.h ?? 'missing'));
        if (hs.size === 1 && !hs.has('missing') && !hs.has(null)) stable++;
        else unstable.push(id);
        if (a.perRun[0]?.stories[id]?.h && a.perRun[0].stories[id].h === refHash.get(id))
          same++;
      }
      const ms = [];
      for (const r of a.perRun)
        for (const s of Object.values(r.stories)) {
          if (typeof s.ms === 'number') ms.push(s.ms);
          if (s.settle) flagged++;
          if (s.error) errors++;
        }
      ms.sort((x, y) => x - y);
      const walls = a.perRun.map((r) => r.wallMs).sort((x, y) => x - y);
      lines.push(
        `| ${a.arm.label} | ${a.perRun.length} | ${ids.size} | ${stable} | ${same} | ${flagged} | ${errors} | ${q(ms, 0.5)} | ${q(ms, 0.95)} | ${q(walls, 0.5)} |`,
      );
      if (unstable.length)
        lines.push(
          `|  unstable: ${unstable.slice(0, 12).join(', ')}${unstable.length > 12 ? ` …(+${unstable.length - 12})` : ''} |||||||||`,
        );
    }
  }
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
