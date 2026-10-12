// Generates packages/core/src/capture/__fixtures__/structure-basic.cdp.json
// from real Chromium. Run: node scripts/capture-structure-fixture.mjs
// Re-run whenever STRUCTURE_PROPS changes; commit the result.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'packages/core/package.json'));
const { chromium } = require('playwright');
const { STRUCTURE_PROPS } = await import(
  path.join(root, 'packages/core/dist/capture/structure.js')
);

const HTML = `<!doctype html><html><head><style>
  body { margin: 8px; font: 16px/1.5 sans-serif; color: rgb(17, 24, 39); }
  .btn { padding: 8px 12px; background: rgb(37, 99, 235); color: white; border-radius: 6px; border: 0; }
  .card { padding: 16px; margin-top: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
  .hidden { visibility: hidden; }
  .star::before { content: "★"; color: rgb(220, 38, 38); }
</style></head><body>
  <main>
    <h1 id="title">Settings</h1>
    <p>Hello <b>there</b> world</p>
    <button class="btn primary" data-testid="save">Save</button>
    <button class="btn" aria-label="Close">×</button>
    <a href="/help">Help</a>
    <img src="/static/logo.png" alt="Logo" width="20" height="20">
    <div class="card"><p>One</p><p>Two</p></div>
    <div style="display:none"><p>gone</p></div>
    <div class="hidden"><p>invisible</p></div>
    <div style="position:absolute; left:-5000px">offscreen</div>
    <div id="masked-area" data-jux-masked="1"><p>secret</p><p>more</p></div>
    <span style="display:inline-block;width:0;height:0"></span>
    <iframe srcdoc="<p>inside</p>" width="80" height="40"></iframe>
    <div id="host"></div>
    <span class="star">Starred</span>
    <svg width="20" height="20"><circle cx="10" cy="10" r="8" fill="#f00"/></svg>
    <input value="typed text" placeholder="Name">
  </main>
  <script>
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
      '<span class="shadow">in shadow</span>';
  </script>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 400, height: 600 },
  deviceScaleFactor: 1,
});
await page.setContent(HTML, { waitUntil: 'load' });
const cdp = await page.context().newCDPSession(page);
const raw = await cdp.send('DOMSnapshot.captureSnapshot', {
  computedStyles: [...STRUCTURE_PROPS, 'visibility'],
  includeDOMRects: true,
  includePaintOrder: true,
});
await browser.close();

const out = path.join(
  root,
  'packages/core/src/capture/__fixtures__/structure-basic.cdp.json',
);
await writeFile(
  out,
  JSON.stringify({ viewport: { width: 400, height: 600 }, raw }) + '\n',
);
console.log(`wrote ${out}`);
