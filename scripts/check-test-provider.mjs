#!/usr/bin/env node
// Boot a real Storybook dev server and assert the juxtapose test provider
// registered in the live manager.
//   node scripts/check-test-provider.mjs examples/storybook
//   node scripts/check-test-provider.mjs path/to/storybook-10-project
//
// Why a live check: #117 shipped because the unit tests mocked the manager
// `api` object, and on Storybook 10 the store getter turned out to be a module
// export rather than an `api` property. Only a real manager bundle, built by
// that Storybook's own esbuild global mapping, shows whether registration
// happened. Exit 0 only when `elements['test-provider']` has juxtapose/tests
// and the testing module rendered it.
//
// Needs `pnpm build` first (it loads the built @juxtapose/core browser driver,
// and the project resolves the built addon).
import { checkStorybookPanel } from './check-storybook-panel.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { acquireBrowser } from '../packages/core/dist/browser/index.js';

const PROVIDER_ID = 'juxtapose/tests';
const BOOT_TIMEOUT_MS = 180_000;
const REGISTER_TIMEOUT_MS = 30_000;

const projectDir = process.argv[2];
if (!projectDir) {
  process.stderr.write('usage: check-test-provider.mjs <storybookProjectDir>\n');
  process.exit(2);
}
const cwd = path.resolve(projectDir);

const port = await freePort();
const url = `http://localhost:${port}/`;
// Its own process group, so the kill below takes the whole tree with it.
const server = spawn(
  'npx',
  ['storybook', 'dev', '-p', String(port), '--ci', '--no-open'],
  {
    cwd,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
let stderr = '';
server.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));

let browser;
let page;
let ok;
try {
  await waitForHttp(url, BOOT_TIMEOUT_MS);
  browser = await acquireBrowser({ noDaemon: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  const index = await (await fetch(`${url}index.json`)).json();
  const storyId = Object.values(index.entries).find((entry) => entry.type === 'story').id;
  await page.goto(`${url}?path=/story/${storyId}&addonPanel=juxtapose/panel`, {
    timeout: 60_000,
  });

  let registered = true;
  await page
    .waitForFunction(
      (id) =>
        Object.keys(
          globalThis.__STORYBOOK_ADDONS_MANAGER?.elements?.['test-provider'] ?? {},
        ).includes(id),
      PROVIDER_ID,
      { timeout: REGISTER_TIMEOUT_MS },
    )
    .catch(() => (registered = false));

  const facts = await page.evaluate(() => {
    const m = globalThis.__STORYBOOK_ADDONS_MANAGER;
    const api = globalThis.__STORYBOOK_API__;
    return {
      providers: Object.keys(m?.elements?.['test-provider'] ?? {}),
      panels: Object.keys(m?.elements?.panel ?? {}),
      moduleGetter: typeof api?.experimental_getTestProviderStore,
    };
  });

  // The registry entry is the regression guard; a rendered row is the proof
  // the manager picked it up. The row's <strong>Visual</strong> label is the
  // addon's own markup (the panel tab is a button, not a <strong>), so it does
  // not depend on either major's testing-module DOM.
  let rendered = true;
  await page
    .waitForFunction(
      () =>
        [...globalThis.document.querySelectorAll('strong')].some(
          (el) => el.textContent === 'Visual',
        ),
      undefined,
      { timeout: REGISTER_TIMEOUT_MS },
    )
    .catch(() => (rendered = false));

  // "Run tests" must reach the addon: on 10 through the store's onRunAll, on
  // 8.6 through a channel event. The POST is intercepted so the check does not
  // start a real capture run.
  const runPosts = rendered ? await clickRunTests(page) : [];

  console.log(`test-provider elements: ${JSON.stringify(facts.providers)}`);
  console.log(`panels: ${JSON.stringify(facts.panels)}`);
  console.log(`module experimental_getTestProviderStore: ${facts.moduleGetter}`);
  console.log(`rendered in testing module: ${rendered}`);
  console.log(`"Run tests" reached the addon: ${runPosts.length > 0}`);
  ok = registered && rendered && runPosts.length > 0;
  if (ok && process.argv.includes('--capture')) {
    const response = await fetch(`${url}jux/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storyIds: [storyId] }),
    });
    if (!response.ok) throw new Error(`Capture start failed: ${await response.text()}`);
    const deadline = Date.now() + 90_000;
    let bundle;
    do {
      bundle = await (await fetch(`${url}jux/api/bundle`)).json();
      if (!bundle.running) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    if (
      bundle.run?.status !== 'completed' ||
      !bundle.report?.results.length ||
      bundle.report.results.some((result) => result.error)
    )
      throw new Error(`Live capture failed: ${JSON.stringify(bundle)}`);
    console.log(`PASS real capture: ${bundle.report.results.length} captures`);
  }
  if (ok) await checkStorybookPanel(page, storyId);
  console.log(
    ok ? `PASS ${PROVIDER_ID} registered` : `FAIL ${PROVIDER_ID} not registered`,
  );
} catch (e) {
  ok = false;
  console.error(`FAIL ${e instanceof Error ? e.message : e}`);
  if (page)
    console.error(
      await page
        .evaluate(
          () =>
            globalThis.document.body.innerText +
            '\n' +
            JSON.stringify(
              [...globalThis.document.querySelectorAll('button')].map((b) => ({
                text: b.textContent.trim(),
                disabled: b.disabled,
                ariaDisabled: b.getAttribute('aria-disabled'),
              })),
            ),
        )
        .catch(() => 'manager unavailable'),
    );
  if (stderr) console.error(stderr);
} finally {
  await browser?.close().catch(() => {});
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}
process.exit(ok ? 0 : 1);

async function clickRunTests(page) {
  const clicked = await page.evaluate(() => {
    globalThis.__juxRunPosts = [];
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (String(input).endsWith('/run') && init?.method === 'POST') {
        globalThis.__juxRunPosts.push(String(input));
        return Promise.resolve(new Response('{}'));
      }
      return original(input, init);
    };
    const button = [...globalThis.document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Run tests',
    );
    button?.click();
    return Boolean(button);
  });
  if (!clicked) return [];
  await page
    .waitForFunction(() => globalThis.__juxRunPosts.length > 0, undefined, {
      timeout: 10_000,
    })
    .catch(() => {});
  return page.evaluate(() => globalThis.__juxRunPosts);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(target, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`storybook exited with ${server.exitCode}`);
    try {
      const res = await fetch(target);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`storybook did not answer at ${target} within ${timeout}ms`);
}
