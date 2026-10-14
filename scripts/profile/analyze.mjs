#!/usr/bin/env node
// Markdown tables from one or more run-profile.mjs output directories.
//
// Usage: node scripts/profile/analyze.mjs <dir> [<dir> ...]
//
// Per variant: median across repeats of wall, story p50/p95, slot and event
// loop utilization, with the spread (min-max); per-phase p50/p95 medians; and
// for each variant against `base`: how many story hashes are identical.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const spread = (xs) => `${Math.min(...xs).toFixed(1)}-${Math.max(...xs).toFixed(1)}`;
const f1 = (v) => (Math.round(v * 10) / 10).toString();
const f2 = (v) => (Math.round(v * 100) / 100).toString();
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

for (const dir of process.argv.slice(2)) {
  const sum = JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const runs = sum.runs.filter((r) => !r.error);
  console.log(
    `\n### ${path.basename(dir)}  (${sum.host?.cpus} cpus, ${sum.host?.model})\n`,
  );
  const groups = new Map();
  for (const r of runs) {
    const k = `${r.variant}|${r.concurrency}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  console.log(
    '| variant | conc | runs | wall s (med, range) | story p50 ms | story p95 ms | slot util | loop util | machine cpu | load1 |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, rs] of groups) {
    const [v, c] = k.split('|');
    console.log(
      `| ${v} | ${c} | ${rs.length} | ${f1(med(rs.map((r) => r.wallS)))} (${spread(rs.map((r) => r.wallS))}) | ${f1(med(rs.map((r) => r.durationMs.p50)))} | ${f1(med(rs.map((r) => r.durationMs.p95)))} | ${f2(med(rs.map((r) => r.slotUtilization)))} | ${f2(med(rs.map((r) => r.preload.eventLoop.utilization)))} | ${f2(med(rs.map((r) => r.cpuBusy ?? 0)))} | ${f1(med(rs.map((r) => r.load1)))} |`,
    );
  }
  console.log('\nPer-phase p50/p95 ms (median across repeats)\n');
  console.log(`| variant | conc | ${PHASES.join(' | ')} |`);
  console.log(`| --- | --- | ${PHASES.map(() => '---').join(' | ')} |`);
  for (const [k, rs] of groups) {
    const [v, c] = k.split('|');
    const cells = PHASES.map(
      (p) =>
        `${f1(med(rs.map((r) => r.phases[p].p50)))}/${f1(med(rs.map((r) => r.phases[p].p95)))}`,
    );
    console.log(`| ${v} | ${c} | ${cells.join(' | ')} |`);
  }
  // Hash identity against the base run of the same repeat and concurrency.
  console.log('\nHash identity vs base (same repeat, same concurrency)\n');
  console.log('| variant | conc | identical / total per repeat |');
  console.log('| --- | --- | --- |');
  for (const [k, rs] of groups) {
    const [v, c] = k.split('|');
    if (v === 'base') continue;
    const cells = rs.map((r) => {
      const base = runs.find(
        (b) =>
          b.variant === 'base' &&
          b.repeat === r.repeat &&
          b.concurrency === r.concurrency,
      );
      if (!base) return 'n/a';
      const ids = Object.keys(base.hashes);
      return `${ids.filter((id) => base.hashes[id] === r.hashes[id]).length}/${ids.length}`;
    });
    console.log(`| ${v} | ${c} | ${cells.join(', ')} |`);
  }
  // Cost buckets of the jux process (median of the first group's repeats).
  const r0 = runs.find((r) => r.variant === 'base') ?? runs[0];
  if (r0) {
    console.log(`\nJux process buckets (${r0.tag}): n, total ms, mean ms, bytes\n`);
    const keep = Object.entries(r0.preload.buckets).filter(
      ([k]) =>
        /^(fs\.|sync\.|sharp|browser\.)/.test(k) ||
        k === 'cdp.Page.captureScreenshot' ||
        k === 'cdp.Runtime.evaluate' ||
        k === 'cdp.DOMSnapshot.captureSnapshot' ||
        k === 'cdp.Page.navigate',
    );
    for (const [k, b] of keep)
      console.log(`- ${k}: ${b.n}, ${b.totalMs}, ${b.meanMs}, ${b.bytes}`);
    console.log(
      `\nEvent loop: utilization ${r0.preload.eventLoop.utilization}, delay ms ${JSON.stringify(r0.preload.eventLoop.delayMs)}; cpu user ${r0.preload.cpuUserMs} ms, system ${r0.preload.cpuSystemMs} ms over ${r0.preload.wallMs} ms wall`,
    );
    if (r0.cpuProfile) {
      console.log(
        `\nTop self-time frames, jux main thread (${r0.cpuProfile.totalMs} ms sampled)\n`,
      );
      for (const t of r0.cpuProfile.top)
        console.log(`- ${t.pct}% ${t.selfMs} ms  ${t.fn}`);
    }
  }
}
