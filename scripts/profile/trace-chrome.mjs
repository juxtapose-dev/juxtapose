#!/usr/bin/env node
// Chrome-side cost of captures, from CDP Tracing: where the browser's own CPU
// goes while jux captures N stories one after another (concurrency 1, so each
// thread's busy time belongs to one capture).
//
// Usage: node scripts/profile/trace-chrome.mjs <buildDir> [count=20] [--out f.json]
//
// Output: per thread class (renderer main, compositor, raster, gpu, browser
// main/IO, other) the busy ms per story and the top event names by self time,
// plus the wall ms per story for scale. Busy time is summed from complete
// ('X') events at nesting depth 0 per thread, so nested events are not counted
// twice; self time per name subtracts children.
// Categories: devtools.timeline, blink, renderer.scheduler, cc, gpu, v8,
// toplevel, plus loading/navigation/browser to see the renderer launch.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const dist = (p) => pathToFileURL(path.join(root, p)).href;
const { Browser, resolveOrAdoptChrome } = await import(
  dist('packages/core/dist/browser/index.js')
);
const { captureStory } = await import(dist('packages/core/dist/capture/capture.js'));
const { serveStatic } = await import(dist('packages/cli/dist/serve-static.js'));
const { StorybookPlatform } = await import(
  dist('packages/adapter-storybook/dist/index.js')
);

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args.splice(outIdx, 2)[1] : undefined;
const [buildArg, countArg = '20'] = args;
const buildDir = path.resolve(buildArg);
const platform = new StorybookPlatform();
const all = (await platform.enumerate({ buildDir, projectRoot: process.cwd() })).filter(
  (s) => s.params.skip !== true,
);
const n = Math.min(Number(countArg), all.length);
const sample = Array.from(
  { length: n },
  (_, i) => all[Math.floor(((i + 0.5) * all.length) / n)],
);

const server = await serveStatic(buildDir);
const chrome = await resolveOrAdoptChrome({}).catch(() => undefined);
const browser = await Browser.launch({
  executablePath: chrome?.path ?? chrome ?? process.env.JUX_CHROME,
});
const conn = browser.connection;
const viewport = { width: 800, height: 600 };
const context = await browser.newContext({ viewport });
const page = await context.newPage();

// Warm the server and the first renderer outside the trace.
await captureStory(page, sample[0], { platform, baseUrl: server.url }, viewport);

const events = [];
const off = conn.on('Tracing.dataCollected', (p) => events.push(...p.value));
const complete = new Promise((resolve) => conn.on('Tracing.tracingComplete', resolve));
await conn.send('Tracing.start', {
  traceConfig: {
    recordMode: 'recordContinuously',
    includedCategories: [
      'devtools.timeline',
      'blink',
      'renderer.scheduler',
      'cc',
      'gpu',
      'v8',
      'toplevel',
      'loading',
      'navigation',
      'browser',
      '__metadata',
    ],
  },
});
const walls = [];
const timings = [];
for (const story of sample) {
  const t = performance.now();
  const snap = await captureStory(
    page,
    story,
    { platform, baseUrl: server.url },
    viewport,
  );
  walls.push(performance.now() - t);
  if (snap?.timings) timings.push(snap.timings);
}
await conn.send('Tracing.end');
await complete;
off();
await browser.close();
await server.close();

// Thread names and process kinds from metadata.
const threadName = new Map();
const procName = new Map();
for (const e of events) {
  if (e.ph !== 'M') continue;
  if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args.name);
  if (e.name === 'process_name') procName.set(e.pid, e.args.name);
}
const cls = (e) => {
  const th = threadName.get(`${e.pid}:${e.tid}`) ?? '';
  const pr = procName.get(e.pid) ?? '';
  if (/CrRendererMain/.test(th)) return 'renderer main';
  if (/Compositor/.test(th) && /Renderer/.test(pr)) return 'renderer compositor';
  if (/Raster|CompositorTile/.test(th)) return 'raster workers';
  if (/Gpu|GPU|VizCompositor/.test(th) || /GPU/.test(pr)) return 'gpu/viz';
  if (/CrBrowserMain/.test(th)) return 'browser main';
  if (/IOThread|ChromeIOThread/.test(th)) return 'browser io';
  if (/Renderer/.test(pr)) return 'renderer other';
  return 'other';
};
// Self time: per thread, sort X events by start, walk with a stack.
const byThread = new Map();
for (const e of events) {
  if (e.ph !== 'X' || e.dur === undefined) continue;
  const k = `${e.pid}:${e.tid}`;
  (byThread.get(k) ?? byThread.set(k, []).get(k)).push(e);
}
const busy = {};
const names = {};
for (const evs of byThread.values()) {
  evs.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const c = cls(evs[0]);
  const stack = [];
  const close = (until) => {
    while (stack.length && stack.at(-1).end <= until) {
      const f = stack.pop();
      const self = f.e.dur - f.child;
      const key = `${f.e.name}`;
      ((names[c] ??= {})[key] ??= { selfUs: 0, n: 0 }).selfUs += self;
      names[c][key].n++;
      if (stack.length) stack.at(-1).child += f.e.dur;
      else busy[c] = (busy[c] ?? 0) + f.e.dur;
    }
  };
  for (const e of evs) {
    close(e.ts);
    stack.push({ e, end: e.ts + e.dur, child: 0 });
  }
  close(Infinity);
}
const per = (us) => Math.round((us / 1000 / n) * 10) / 10;
const result = {
  stories: n,
  wallMsPerStory: Math.round(walls.reduce((a, b) => a + b, 0) / n),
  busyMsPerStory: Object.fromEntries(Object.entries(busy).map(([k, v]) => [k, per(v)])),
  top: Object.fromEntries(
    Object.entries(names).map(([c, m]) => [
      c,
      Object.entries(m)
        .sort((a, b) => b[1].selfUs - a[1].selfUs)
        .slice(0, 12)
        .map(([name, v]) => ({
          name,
          selfMsPerStory: per(v.selfUs),
          callsPerStory: Math.round((v.n / n) * 10) / 10,
        })),
    ]),
  ),
  jux: timings.length
    ? Object.fromEntries(
        Object.keys(timings[0]).map((k) => [
          k,
          Math.round((timings.reduce((a, t) => a + t[k], 0) / timings.length) * 10) / 10,
        ]),
      )
    : undefined,
};
console.log(JSON.stringify({ ...result, top: undefined }, null, 1));
for (const [c, list] of Object.entries(result.top)) {
  console.log(`\n${c} (busy ${result.busyMsPerStory[c]} ms/story)`);
  for (const t of list.slice(0, 8))
    console.log(
      `  ${String(t.selfMsPerStory).padStart(7)} ms  ${t.callsPerStory}x  ${t.name}`,
    );
}
if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 1));
