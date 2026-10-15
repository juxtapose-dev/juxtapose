#!/usr/bin/env node
// pnpm build; JUX_STATE_DIR=$(mktemp -d) node scripts/profile-encoder.mjs
// Frozen local UI frame, four warmups then 40 alternating samples per encoder.
// Includes screenshot/transfer plus encoding; excludes navigation and settling.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(root + '/packages/core/package.json');
const sharp = require('sharp');
const { Browser } = await import(root + '/packages/core/dist/browser/browser.js');
const { resolveChrome } = await import(root + '/packages/core/dist/browser/resolve.js');
const { canonicalWebp } = await import(root + '/packages/core/dist/capture/encoder.js');
const html =
  '<body style="margin:0;background:#fafafa"><div style="height:120px;background:linear-gradient(90deg,#f00,#0f0,#00f,#ff0)"></div>' +
  Array.from(
    { length: 24 },
    (_, i) =>
      `<section style="display:inline-block;width:220px;padding:12px;border:1px solid #ddd;border-radius:12px"><h2>Card ${i}</h2><p>Snapshot text 0123456789</p><button>Continue</button></section>`,
  ).join('');
const server = createServer((q, r) => r.end(html));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await Browser.launch({ executablePath: resolveChrome().path });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate('document.fonts.ready');
  const rows = [];
  for (let i = 0; i < 44; i++) {
    for (const mode of i % 2 ? ['native', 'sharp'] : ['sharp', 'native']) {
      const t = performance.now();
      const shot = await page.screenshot({ format: mode === 'native' ? 'webp' : 'png' });
      const captured = performance.now();
      const image =
        mode === 'native'
          ? canonicalWebp(shot)
          : await sharp(shot).webp({ lossless: true, effort: 0 }).toBuffer();
      const end = performance.now();
      if (i >= 4)
        rows.push({
          mode,
          total: end - t,
          screenshot: captured - t,
          encode: end - captured,
          bytes: image.length,
        });
    }
  }
  for (const mode of ['sharp', 'native']) {
    const rs = rows.filter((r) => r.mode === mode);
    const median = (k) => rs.map((r) => r[k]).sort((a, b) => a - b)[20];
    console.log(
      JSON.stringify({
        mode,
        n: rs.length,
        totalMedianMs: median('total'),
        screenshotMedianMs: median('screenshot'),
        encodeMedianMs: median('encode'),
        bytes: median('bytes'),
      }),
    );
  }
} finally {
  await browser.close();
  server.close();
}
