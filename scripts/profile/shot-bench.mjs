#!/usr/bin/env node
// Where a capture's screenshot-and-encode time goes, and which cheaper ways of
// getting the same bytes exist. For each sampled story: capture it normally
// (captureStory, so the page is settled and `timings` are recorded), then on
// the settled page time every way of taking the frame:
//
//   png        Page.captureScreenshot png                     (what jux does)
//   png-speed  ... with optimizeForSpeed: true                (same pixels?)
//   webp-q100  format webp, quality 100 (Chrome-encoded)      (comparison only)
//   webp-ll    format webp, no quality                        (comparison only)
//
// and the jux-side costs: base64 decode, sharp PNG decode (raw), WebP encode,
// both from the PNG (as jux does) and from raw pixels (the lower bound for
// "skip the PNG round-trip"). It checks the WebP bytes from png-speed equal
// the current ones, and whether raw -> WebP equals PNG -> WebP.
//
// Usage: node scripts/profile/shot-bench.mjs <buildDir> [count=40] [--out f.json]
// Needs `pnpm build`. Prints a table; writes the raw rows with --out.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const dist = (p) => pathToFileURL(path.join(root, p)).href;
const { Browser } = await import(dist('packages/core/dist/browser/index.js'));
const { captureStory } = await import(dist('packages/core/dist/capture/capture.js'));
const { serveStatic } = await import(dist('packages/cli/dist/serve-static.js'));
const { StorybookPlatform } = await import(
  dist('packages/adapter-storybook/dist/index.js')
);
const { resolveChrome } = await import(dist('packages/core/dist/browser/index.js')).then(
  (m) => ({ resolveChrome: m.resolveOrAdoptChrome }),
);
const sharp = createRequire(path.join(root, 'packages/core/package.json'))('sharp');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args.splice(outIdx, 2)[1] : undefined;
const [buildArg, countArg = '40'] = args;
if (!buildArg) {
  console.error('usage: shot-bench.mjs <buildDir> [count] [--out file]');
  process.exit(2);
}
const buildDir = path.resolve(buildArg);
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const ms = (t0) => performance.now() - t0;

const platform = new StorybookPlatform();
const all = (await platform.enumerate({ buildDir, projectRoot: process.cwd() })).filter(
  (s) => s.params.skip !== true,
);
// Evenly strided, so the sample spans the whole index rather than one component.
const n = Math.min(Number(countArg), all.length);
const sample = Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]);

const server = await serveStatic(buildDir);
const chrome = await resolveChrome({}).catch(() => undefined);
const browser = await Browser.launch({
  executablePath: chrome?.path ?? chrome ?? process.env.JUX_CHROME,
});
const viewport = { width: 800, height: 600 };
const context = await browser.newContext({ viewport });
const page = await context.newPage();

async function shot(extra) {
  const t0 = performance.now();
  await page.send('Page.getLayoutMetrics').then(() => {});
  const { visualViewport: v } = await page.send('Page.getLayoutMetrics');
  const clip = {
    x: v.pageX,
    y: v.pageY,
    width: Math.ceil(viewport.width / v.scale),
    height: Math.ceil(viewport.height / v.scale),
    scale: v.scale,
  };
  const t1 = performance.now();
  const { data } = await page.send('Page.captureScreenshot', {
    clip,
    captureBeyondViewport: false,
    ...extra,
  });
  const cdp = ms(t1);
  const t2 = performance.now();
  const buf = Buffer.from(data, 'base64');
  return { buf, cdp, b64: ms(t2), b64len: data.length, pre: t1 - t0 };
}

function riffChunks(buf) {
  const out = [];
  for (let o = 12; o + 8 <= buf.length;) {
    const type = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    out.push({ type, size, hash: sha(buf.subarray(o + 8, o + 8 + size)) });
    o += 8 + size + (size & 1);
  }
  return out;
}
function countDiff(a, b, ch) {
  if (a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i += ch) {
    for (let c = 0; c < ch; c++)
      if (a[i + c] !== b[i + c]) {
        n++;
        break;
      }
  }
  return n;
}
// The same settled frame, taken REPEATS times: how many distinct byte strings.
const REPEATS = Number(process.env.BENCH_REPEATS ?? 20);
async function repeats(extra) {
  if (!REPEATS) return undefined;
  const seen = new Set();
  for (let i = 0; i < REPEATS; i++) seen.add(sha((await shot(extra)).buf));
  return seen.size === 1;
}
const rows = [];
for (const story of sample) {
  const row = { id: story.storyId };
  try {
    const snap = await captureStory(
      page,
      story,
      { platform, baseUrl: server.url },
      viewport,
    );
    if (!snap) continue;
    row.timings = snap.timings;
    row.durationMs = snap.durationMs;
    row.webpBytes = snap.image.length;
    row.hash = sha(snap.image);
    // Warm-up so the first variant is not charged for a cold encoder path.
    await shot({ format: 'png' });
    const png = await shot({ format: 'png' });
    const fast = await shot({ format: 'png', optimizeForSpeed: true });
    row.png = { cdp: png.cdp, b64: png.b64, bytes: png.buf.length };
    row.pngSpeed = { cdp: fast.cdp, b64: fast.b64, bytes: fast.buf.length };
    for (const [key, extra] of [
      ['webpQ100', { format: 'webp', quality: 100 }],
      ['webpDefault', { format: 'webp' }],
    ]) {
      // PNG taken right before and right after: a frame that moves between
      // shots (a canvas) is told apart from a lossy encoder.
      const before = await shot({ format: 'png' });
      const w = await shot(extra);
      const after = await shot({ format: 'png' });
      const t = performance.now();
      const raw = await sharp(w.buf).raw().toBuffer({ resolveWithObject: true });
      const ref = await sharp(before.buf).raw().toBuffer();
      const ref2 = await sharp(after.buf).raw().toBuffer();
      // Chrome embeds an ICC profile; sharp applies it on decode unless told not to.
      const rawNoIcc = await sharp(w.buf, { ignoreIcc: true }).raw().toBuffer();
      const chunks = riffChunks(w.buf);
      if (!ref.equals(ref2)) row.frameMoved = true;
      row[key] = {
        cdp: w.cdp,
        bytes: w.buf.length,
        decodeMs: ms(t),
        samePixelsAsPng: raw.data.equals(ref),
        samePixelsIgnoreIcc: rawNoIcc.equals(ref),
        chunks: chunks.map((c) => c.type).join(','),
        iccHash: chunks.find((c) => c.type === 'ICCP')?.hash,
        differingPixels: raw.data.equals(ref)
          ? 0
          : countDiff(raw.data, ref, raw.info.channels),
        repeatsIdentical: key === 'webpQ100' ? await repeats(extra) : undefined,
      };
    }
    // jux-side costs, from the PNG as jux does it.
    let t = performance.now();
    const raw = await sharp(png.buf).raw().toBuffer({ resolveWithObject: true });
    row.decodeMs = ms(t);
    t = performance.now();
    const fromPng = await sharp(png.buf).webp({ lossless: true, effort: 0 }).toBuffer();
    row.pngToWebpMs = ms(t);
    t = performance.now();
    const fromFast = await sharp(fast.buf).webp({ lossless: true, effort: 0 }).toBuffer();
    row.fastToWebpMs = ms(t);
    const { width, height, channels } = raw.info;
    t = performance.now();
    const fromRaw = await sharp(raw.data, { raw: { width, height, channels } })
      .webp({ lossless: true, effort: 0 })
      .toBuffer();
    row.rawToWebpMs = ms(t);
    row.channels = channels;
    row.sameAsCaptured = fromPng.equals(snap.image);
    row.fastSameWebp = fromFast.equals(fromPng);
    row.rawSameWebp = fromRaw.equals(fromPng);
    // The Chrome-encoded WebP against jux's own: report, never adopt.
    row.chromeWebpSameBytes = row.webpQ100.bytes === fromPng.length;
  } catch (e) {
    row.error = String(e?.message ?? e).slice(0, 200);
  }
  rows.push(row);
}

await browser.close();
await server.close();

const ok = rows.filter((r) => !r.error && r.png);
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const line = (name, xs) =>
  `${name.padEnd(34)} p50 ${pct(xs, 50).toFixed(1).padStart(7)}  p95 ${pct(xs, 95).toFixed(1).padStart(7)}  mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1).padStart(7)}`;
console.log(`stories: ${ok.length} ok of ${rows.length}   (ms)`);
console.log(
  line(
    'captureStory total (durationMs)',
    ok.map((r) => r.durationMs),
  ),
);
console.log(
  line(
    '  timings.screenshot (page.screenshot)',
    ok.map((r) => r.timings.screenshot),
  ),
);
console.log(
  line(
    '  timings.encode (sharp, whole)',
    ok.map((r) => r.timings.encode),
  ),
);
console.log(
  line(
    'CDP captureScreenshot png',
    ok.map((r) => r.png.cdp),
  ),
);
console.log(
  line(
    'CDP captureScreenshot png optForSpeed',
    ok.map((r) => r.pngSpeed.cdp),
  ),
);
console.log(
  line(
    'CDP captureScreenshot webp q100',
    ok.map((r) => r.webpQ100.cdp),
  ),
);
console.log(
  line(
    'CDP captureScreenshot webp default',
    ok.map((r) => r.webpDefault.cdp),
  ),
);
console.log(
  line(
    'base64 -> Buffer (png)',
    ok.map((r) => r.png.b64),
  ),
);
console.log(
  line(
    'sharp PNG decode (raw)',
    ok.map((r) => r.decodeMs),
  ),
);
console.log(
  line(
    'sharp PNG -> WebP (jux today)',
    ok.map((r) => r.pngToWebpMs),
  ),
);
console.log(
  line(
    'sharp fastPNG -> WebP',
    ok.map((r) => r.fastToWebpMs),
  ),
);
console.log(
  line(
    'sharp raw -> WebP (lower bound)',
    ok.map((r) => r.rawToWebpMs),
  ),
);
const sum = (f) => ok.filter(f).length;
console.log(
  `Chrome webp q100 differing pixels (stories that differ): ${
    ok
      .filter((r) => r.webpQ100.differingPixels)
      .map((r) => r.id + '=' + r.webpQ100.differingPixels)
      .join(', ') || 'none'
  }; ` +
    `${REPEATS}x repeat identical: ${sum((r) => r.webpQ100.repeatsIdentical)}/${ok.length}; ` +
    `Chrome webp bytes p50 ${pct(
      ok.map((r) => r.webpQ100.bytes),
      50,
    )} vs jux ${pct(
      ok.map((r) => r.webpBytes),
      50,
    )}`,
);
console.log(
  `PNG bytes p50 ${pct(
    ok.map((r) => r.png.bytes),
    50,
  )}, optForSpeed ${pct(
    ok.map((r) => r.pngSpeed.bytes),
    50,
  )}, WebP ${pct(
    ok.map((r) => r.webpBytes),
    50,
  )}`,
);
console.log(
  `channels: ${[...new Set(ok.map((r) => r.channels))].join(',')}; ` +
    `re-encode == captured WebP: ${sum((r) => r.sameAsCaptured)}/${ok.length}; ` +
    `optForSpeed PNG -> same WebP: ${sum((r) => r.fastSameWebp)}/${ok.length}; ` +
    `raw -> same WebP: ${sum((r) => r.rawSameWebp)}/${ok.length}; ` +
    `Chrome webp q100 same pixels as PNG: ${sum((r) => r.webpQ100.samePixelsAsPng)}/${ok.length}; ` +
    `Chrome webp default same pixels: ${sum((r) => r.webpDefault.samePixelsAsPng)}/${ok.length}`,
);
console.log(
  `Chrome webp q100 same pixels ignoring ICC: ${sum((r) => r.webpQ100.samePixelsIgnoreIcc)}/${ok.length}; ` +
    `chunk layouts: ${[...new Set(ok.map((r) => r.webpQ100.chunks))].join(' | ')}; ` +
    `distinct ICCP payloads: ${new Set(ok.map((r) => r.webpQ100.iccHash)).size}`,
);
for (const r of rows.filter((r) => r.error)) console.log(`error ${r.id}: ${r.error}`);
if (outFile) writeFileSync(outFile, JSON.stringify(rows, null, 1));
