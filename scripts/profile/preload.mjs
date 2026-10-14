// Measurement-only instrumentation of a `jux run` process, loaded with
//   node --import scripts/profile/preload.mjs packages/cli/dist/index.js run ...
// and writing $JUX_PROFILE_OUT/preload.json at exit. It wraps calls from the
// outside (property patching), so nothing in the capture path is edited:
//
//   event loop     utilization and the delay histogram of the jux process
//   fs             writeFile/readFile/rename/mkdir: count, ms, bytes
//   sync work      zlib.gzipSync/gunzipSync, crypto hash digests: count, ms.
//                  These run on the main thread and block CDP for every worker.
//   cdp            per method: count and round-trip ms (send -> response)
//   sharp          pipeline toBuffer calls: count, ms (these run on libuv's pool)
//
// Everything here costs a few microseconds per call; it is for profiling runs,
// never for the field tests whose wall time is gated.

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = process.env.JUX_PROFILE_OUT;
if (!out) throw new Error('JUX_PROFILE_OUT must name an output directory');
fs.mkdirSync(out, { recursive: true });

const stat = () => ({ n: 0, ms: 0, bytes: 0, max: 0 });
const buckets = new Map();
const bucket = (k) => {
  let b = buckets.get(k);
  if (!b) buckets.set(k, (b = stat()));
  return b;
};
const note = (k, ms, bytes = 0) => {
  const b = bucket(k);
  b.n++;
  b.ms += ms;
  b.bytes += bytes;
  if (ms > b.max) b.max = ms;
};

// Async fs: the time a caller waits, which includes libuv queueing.
for (const name of [
  'writeFile',
  'readFile',
  'rename',
  'mkdir',
  'rm',
  'readdir',
  'lstat',
]) {
  const orig = fsp[name];
  fsp[name] = async function (...a) {
    const t = performance.now();
    try {
      const r = await orig.apply(this, a);
      const bytes =
        name === 'readFile'
          ? (r?.length ?? 0)
          : name === 'writeFile'
            ? (a[1]?.length ?? 0)
            : 0;
      note(`fs.${name}`, performance.now() - t, bytes);
      return r;
    } catch (e) {
      note(`fs.${name}`, performance.now() - t);
      throw e;
    }
  };
}
// Synchronous work on the main thread.
for (const name of ['gzipSync', 'gunzipSync', 'deflateSync', 'inflateSync']) {
  const orig = zlib[name];
  zlib[name] = function (buf, ...rest) {
    const t = performance.now();
    const r = orig.call(this, buf, ...rest);
    note(`sync.zlib.${name}`, performance.now() - t, buf?.length ?? 0);
    return r;
  };
}
const origCreateHash = crypto.createHash;
crypto.createHash = function (...a) {
  const h = origCreateHash.apply(this, a);
  let bytes = 0;
  const upd = h.update.bind(h);
  const dig = h.digest.bind(h);
  h.update = (d, ...r) => ((bytes += d?.length ?? 0), upd(d, ...r));
  h.digest = (...r) => {
    const t = performance.now();
    const v = dig(...r);
    note(`sync.hash.${a[0]}`, performance.now() - t, bytes);
    return v;
  };
  return h;
};
syncBuiltinESMExports();

// CDP round trips, and sharp pipelines, from the packages' own copies.
const root = path.resolve(import.meta.dirname, '../..');
const core = path.join(root, 'packages/core');
const { CdpConnection } = await import(
  pathToFileURL(path.join(core, 'dist/browser/cdp.js')).href
);
const origSend = CdpConnection.prototype.send;
CdpConnection.prototype.send = function (method, ...rest) {
  const t = performance.now();
  const p = origSend.call(this, method, ...rest);
  const done = () => note(`cdp.${method}`, performance.now() - t);
  p.then(done, done);
  return p;
};
// Browser launch and per-worker context/page creation (once per worker, not per story).
const { Browser, BrowserContext } = await import(
  pathToFileURL(path.join(core, 'dist/browser/browser.js')).href
);
const origLaunch = Browser.launch;
Browser.launch = async function (...a) {
  const t = performance.now();
  try {
    return await origLaunch.apply(this, a);
  } finally {
    note('browser.launch', performance.now() - t);
  }
};
const origNewContext = Browser.prototype.newContext;
Browser.prototype.newContext = async function (...a) {
  const t = performance.now();
  try {
    return await origNewContext.apply(this, a);
  } finally {
    note('browser.newContext', performance.now() - t);
  }
};
const origNewPage = BrowserContext.prototype.newPage;
BrowserContext.prototype.newPage = async function (...a) {
  const t = performance.now();
  try {
    return await origNewPage.apply(this, a);
  } finally {
    note('browser.newPage', performance.now() - t);
  }
};
const sharp = createRequire(path.join(core, 'package.json'))('sharp');
// EXPERIMENT hooks, set from run-profile variants: libvips thread count.
if (process.env.JUX_PRELOAD_SHARP_CONC)
  sharp.concurrency(Number(process.env.JUX_PRELOAD_SHARP_CONC));
const proto = Object.getPrototypeOf(sharp());
const origToBuffer = proto.toBuffer;
proto.toBuffer = function (...a) {
  const t = performance.now();
  const p = origToBuffer.apply(this, a);
  if (a.length && typeof a[0] === 'function') return p;
  return p.then((r) => {
    const buf = r?.data ?? r;
    note('sharp.toBuffer', performance.now() - t, buf?.length ?? 0);
    return r;
  });
};

const eld = monitorEventLoopDelay({ resolution: 1 });
eld.enable();
const elu0 = performance.eventLoopUtilization();
const cpu0 = process.cpuUsage();
const t0 = performance.now();

process.on('exit', () => {
  eld.disable();
  const elu = performance.eventLoopUtilization(elu0);
  const cpu = process.cpuUsage(cpu0);
  const wall = performance.now() - t0;
  const ns = (v) => Math.round(v / 1e4) / 100; // ns -> ms, 2 dp
  fs.writeFileSync(
    path.join(out, 'preload.json'),
    JSON.stringify(
      {
        wallMs: Math.round(wall),
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        eventLoop: {
          utilization: Math.round(elu.utilization * 1000) / 1000,
          activeMs: Math.round(elu.active),
          delayMs: {
            mean: ns(eld.mean),
            p50: ns(eld.percentile(50)),
            p99: ns(eld.percentile(99)),
            max: ns(eld.max),
          },
        },
        buckets: Object.fromEntries(
          [...buckets].map(([k, b]) => [
            k,
            {
              n: b.n,
              totalMs: Math.round(b.ms * 10) / 10,
              meanMs: Math.round((b.ms / b.n) * 100) / 100,
              maxMs: Math.round(b.max * 10) / 10,
              bytes: b.bytes,
            },
          ]),
        ),
      },
      null,
      1,
    ),
  );
});
