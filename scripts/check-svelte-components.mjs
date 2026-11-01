#!/usr/bin/env node
/* global document, requestAnimationFrame */
// Opt-in integration check: uses a project's installed Svelte/Vite plugins and jux's
// pinned browser. Build core first. No dependency installation or external fixtures.
// node scripts/check-svelte-components.mjs <svelte-project> [artifact-parent]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Browser } from '../packages/core/dist/browser/browser.js';
import { resolveChrome } from '../packages/core/dist/browser/resolve.js';
import { svelteComponentInstrumentation } from '../packages/core/dist/analysis/svelte-components.js';

if (!process.argv[2])
  throw new Error('Pass a project with Svelte 5, Vite and vite-plugin-svelte installed.');
const project = path.resolve(process.argv[2]);
const require = createRequire(path.join(project, 'package.json'));
const compiler = require('svelte/compiler');
assert.match(compiler.VERSION, /^5\./);
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const { svelte } = await import(
  pathToFileURL(require.resolve('@sveltejs/vite-plugin-svelte')).href
);
const chrome = resolveChrome();
if (!chrome) throw new Error('Install jux’s pinned browser before this check.');
const parent = path.resolve(process.argv[3] ?? tmpdir());
await mkdir(parent, { recursive: true });
const repository = await mkdtemp(path.join(parent, 'jux-svelte-components-'));
execFileSync('git', ['init', '--quiet', repository]);
const root = path.join(repository, 'apps/workbench');
await mkdir(root, { recursive: true });
await symlink(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'dir');
await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
const fixtures = {
  'App.svelte': `<script lang="ts">import Fragment from './Fragment.svelte';import Empty from './Empty.svelte';import Text from './Text.svelte';import Wrapper from './Wrapper.svelte';let show=$state(true);const __jux_svelte_0='collision';</script><main><button onclick={()=>show=!show}>Toggle</button>{#if show}<section>{#each [1,2] as item}<Fragment name={'repeat '+item}/>{/each}<Empty/><Text/><Wrapper>{#snippet children()}<Fragment name="snippet child"/><b>snippet native</b>{/snippet}</Wrapper></section>{/if}</main>`,
  'Fragment.svelte': `<script>let {name}=$props();</script><p>{name}</p><svelte:element this={'span'}>fragment root</svelte:element>`,
  'Empty.svelte': `<script>const nothing=1;</script>`,
  'Text.svelte': `text only`,
  'Wrapper.svelte': `<script>let {children}=$props();</script><article>{@render children()}</article>`,
  'entry.js': `import{mount,unmount,tick}from'svelte';import App from'./App.svelte';const app=mount(App,{target:document.body});globalThis.dispose=async()=>{await unmount(app);await tick()};await tick();globalThis.ready=true;`,
  'index.html': `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'"><style>body{font-family:Arial;margin:10px}p,span,b{display:block}</style></head><body><script type="module" src="/entry.js"></script></body></html>`,
};
for (const [name, source] of Object.entries(fixtures))
  await writeFile(path.join(root, name), source);
for (const mode of ['plain', 'instrumented']) {
  await build({
    configFile: false,
    base: `/${mode}/`,
    root,
    logLevel: 'error',
    plugins: [
      ...(mode === 'instrumented' ? [svelteComponentInstrumentation(root)] : []),
      svelte({ compilerOptions: { dev: false } }),
    ],
    build: {
      outDir: path.join(root, mode),
      emptyOutDir: true,
      sourcemap: false,
      target: 'esnext',
    },
  });
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/(plain|instrumented)(\/|\/assets\/[\w.-]+)$/.exec(url.pathname);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const file = match[2] === '/' ? '/index.html' : match[2];
    const bytes = await readFile(path.join(root, match[1], file));
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const results = {};
const collect = () => {
  const registry = globalThis[Symbol.for('juxtapose.svelte.components/v1')];
  return registry.collect([...document.querySelectorAll('main, main *')]);
};
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  browser = await Browser.launch({ executablePath: chrome.path });
  for (const mode of ['plain', 'instrumented']) {
    const context = await browser.newContext({
      viewport: { width: 640, height: 480 },
      blockServiceWorkers: true,
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
        errors.push(exceptionDetails.text),
      );
      await page.goto(`http://127.0.0.1:${address.port}/${mode}/`, { timeout: 10000 });
      await page.waitForFunction(() => globalThis.ready === true, undefined, {
        timeout: 10000,
      });
      const snapshots = [];
      for (const state of ['initial', 'conditional-unmounted']) {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        const image = await page.screenshot({ format: 'png' });
        await writeFile(path.join(root, `${mode}-${state}.png`), image);
        snapshots.push({
          state,
          sha256: createHash('sha256').update(image).digest('hex'),
          html: await page.evaluate(() => document.querySelector('main').outerHTML),
        });
        if (state === 'initial') {
          if (mode === 'instrumented') {
            const graph = await page.evaluate(collect);
            results.graph = graph;
            assert.equal(graph.status, 'partial');
            assert.equal(graph.relation, 'instrumented-context');
            assert.equal(graph.elementRelation, 'declared-by');
            assert.equal(graph.nodes.length, 7);
            assert.equal(new Set(graph.nodes.map((n) => n.id)).size, 7);
            const app = graph.nodes.find((n) => n.name === 'App');
            const wrapper = graph.nodes.find((n) => n.name === 'Wrapper');
            const fragments = graph.nodes.filter((n) => n.name === 'Fragment');
            assert.equal(fragments.length, 3);
            assert.ok(fragments.every((n) => n.elements.length === 2));
            assert.equal(fragments[0].parent, app.id);
            assert.equal(fragments[1].parent, app.id);
            assert.equal(fragments[2].parent, wrapper.id);
            for (const name of ['Empty', 'Text'])
              assert.deepEqual(graph.nodes.find((n) => n.name === name).elements, []);
            assert.ok(
              graph.nodes.every(
                (n) => n.source.file === `apps/workbench/${n.name}.svelte`,
              ),
            );
            const nativeSnippetIndex = await page.evaluate(() =>
              [...document.querySelectorAll('main, main *')].indexOf(
                document.querySelector('b'),
              ),
            );
            assert.ok(app.elements.includes(nativeSnippetIndex));
            const masked = await page.evaluate(() =>
              globalThis[Symbol.for('juxtapose.svelte.components/v1')].collect(
                [...document.querySelectorAll('main *')],
                [document.querySelector('article')],
              ),
            );
            assert.equal(masked.status, 'unavailable');
            assert.equal(masked.reason, 'masked');
            assert.deepEqual(masked.nodes, []);
            results.masked = masked;
          }
          await page.evaluate(() => document.querySelector('button').click());
          await page.waitForFunction(
            () => !document.querySelector('section'),
            undefined,
            { timeout: 10000 },
          );
          if (mode === 'instrumented') {
            const after = await page.evaluate(collect);
            assert.equal(after.nodes.length, 1);
            assert.equal(after.nodes[0].name, 'App');
          }
        }
      }
      await page.evaluate(() => globalThis.dispose());
      if (mode === 'instrumented')
        assert.equal((await page.evaluate(collect)).nodes.length, 0);
      assert.deepEqual(errors, []);
      results[mode] = snapshots;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(results.plain, results.instrumented);
  const proof = {
    ok: true,
    compilerVersion: compiler.VERSION,
    dev: false,
    domIdentical: true,
    pixelIdentical: true,
    results,
  };
  await writeFile(path.join(root, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(
    JSON.stringify({
      ok: true,
      compilerVersion: compiler.VERSION,
      instances: results.graph.nodes.length,
      pixelIdentical: true,
      domIdentical: true,
      proof: path.join(root, 'proof.json'),
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
