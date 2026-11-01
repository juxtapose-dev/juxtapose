/* global document, window */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { collectVueComponents } from './vue.js';
import { beginComponentCapture, finishComponentCapture } from '../capture/components.js';
import { captureStructure } from '../capture/structure.js';

const chrome = chromeForTests();
const requireExample = createRequire(
  new URL('../../../../examples/storybook-vue/package.json', import.meta.url),
);
let server: Server;
let base: string;
let output: string;
const collector = collectVueComponents.toString();

beforeAll(async () => {
  output = await mkdtemp(path.join(tmpdir(), 'jux-vue-components-'));
  const { build } = await import(
    pathToFileURL(
      path.join(
        path.dirname(requireExample.resolve('vite/package.json')),
        'dist/node/index.js',
      ),
    ).href
  );
  for (const enabled of [false, true]) {
    await build({
      root: fileURLToPath(new URL('./__fixtures__/vue/', import.meta.url)),
      configFile: false,
      base: './',
      logLevel: 'silent',
      resolve: {
        alias: { vue: requireExample.resolve('vue/dist/vue.runtime.esm-bundler.js') },
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: String(enabled),
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      },
      build: { outDir: path.join(output, String(enabled)), emptyOutDir: true },
    });
  }
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, 'http://localhost').pathname;
    const file = path.join(
      output,
      pathname.endsWith('/') ? `${pathname}index.html` : pathname,
    );
    try {
      res.setHeader(
        'content-type',
        file.endsWith('.js') ? 'application/javascript' : 'text/html',
      );
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  if (output) await rm(output, { recursive: true, force: true });
});

describe.skipIf(!chrome)('Vue component metadata in a real Vite production build', () => {
  it('retains repeated instances, fragment ownership, Teleport and zero-element children', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
      const page = await context.newPage();
      await page.goto(`${base}/true/`);
      await page.waitForFunction(() => Object.hasOwn(window, 'fixtureReady'));
      const result = (await page.evaluate(
        `(${collector})(Array.from(document.querySelectorAll('main, b, i, strong, small')))`,
      )) as ReturnType<typeof collectVueComponents>;
      expect(result.status).toBe('ok');
      expect(result.runtimeVersion).toMatch(/^3\./);
      expect(result.nodes.filter((n) => n.name === 'RepeatedLeaf')).toHaveLength(2);
      const root = result.nodes.find((n) => n.name === 'FixtureRoot')!;
      expect(result.nodes.find((n) => n.name === 'FragmentLeaf')).toMatchObject({
        parent: root.id,
        elements: [3, 4],
      });
      expect(result.nodes.find((n) => n.name === 'PortalLeaf')).toMatchObject({
        parent: root.id,
        elements: [6],
      });
      expect(result.nodes.find((n) => n.name === 'EmptyLeaf')).toMatchObject({
        parent: root.id,
        elements: [],
      });
      expect(result.nodes.find((n) => n.name === 'TextLeaf')).toMatchObject({
        parent: root.id,
        elements: [],
      });
      expect(JSON.stringify(result)).not.toMatch(/setupState|props|updateFixture/);
      await context.close();
    } finally {
      await browser.close();
    }
  });
  it('reports unsupported default production and does not change pixels with hooks enabled', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
      const page = await context.newPage();
      await page.goto(`${base}/false/`);
      await page.waitForFunction(() => Object.hasOwn(window, 'fixtureReady'));
      const disabledPixels = await page.screenshot();
      const disabled = await page.evaluate(
        `(${collector})(Array.from(document.querySelectorAll('*')))`,
      );
      expect(disabled).toMatchObject({
        status: 'unavailable',
        reason: 'runtime_hooks_unavailable',
        nodes: [],
      });
      await page.goto(`${base}/true/`);
      await page.waitForFunction(() => Object.hasOwn(window, 'fixtureReady'));
      const before = await page.screenshot();
      expect(before.equals(disabledPixels)).toBe(true);
      const domBefore = await page.evaluate(() => document.documentElement.outerHTML);
      await page.evaluate(`(${collector})(Array.from(document.querySelectorAll('*')))`);
      const after = await page.screenshot();
      expect(after.equals(before)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(
        domBefore,
      );
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('takes a fresh instance graph after an update, without evaluating user getters', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
      const page = await context.newPage();
      await page.goto(`${base}/true/`);
      await page.waitForFunction(() => Object.hasOwn(window, 'fixtureReady'));
      const before = (await page.evaluate(
        `(${collector})(Array.from(document.querySelectorAll('*')))`,
      )) as ReturnType<typeof collectVueComponents>;
      expect(before.nodes.some((n) => n.name === 'TransientLeaf')).toBe(true);
      await page.evaluate('window.updateFixture()');
      const after = (await page.evaluate(
        `(${collector})(Array.from(document.querySelectorAll('*')))`,
      )) as ReturnType<typeof collectVueComponents>;
      expect(after.nodes.some((n) => n.name === 'TransientLeaf')).toBe(false);
      expect(after.status).toBe('ok');
      const getter = await page.evaluate(`(() => {
        let reads = 0;
        const instance = document.querySelector('main').__vueParentComponent;
        Object.defineProperty(instance, 'props', { configurable: true, get() { reads++; throw new Error('private'); } });
        const snapshot = (${collector})([document.querySelector('main')]);
        return { snapshot, reads };
      })()`);
      expect(getter).toMatchObject({ reads: 0, snapshot: { status: 'ok' } });
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('bounds real large trees and fails closed for masks including zero-element descendants', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
      const page = await context.newPage();
      await page.goto(`${base}/true/`);
      await page.waitForFunction(() => Object.hasOwn(window, 'fixtureReady'));
      const maskedResult = (await page.evaluate(`(() => {
        let reads = 0;
        const element = document.querySelector('b');
        const original = Object.getOwnPropertyDescriptor(element, '__vueParentComponent');
        Object.defineProperty(element, '__vueParentComponent', { configurable: true, get() { reads++; throw new Error('masked'); } });
        const snapshot = (${collector})([element], [document.querySelector('main')]);
        Object.defineProperty(element, '__vueParentComponent', original);
        return { snapshot, reads };
      })()`)) as { snapshot: ReturnType<typeof collectVueComponents>; reads: number };
      expect(maskedResult.reads).toBe(0);
      const masked = maskedResult.snapshot;
      expect(masked).toEqual({
        framework: 'vue',
        relation: 'rendered-parent',
        status: 'unavailable',
        reason: 'masked',
        truncated: false,
        nodes: [],
      });
      await page.evaluate('window.fillFixture()');
      const capped = (await page.evaluate(
        `(${collector})([document.querySelector('main')])`,
      )) as ReturnType<typeof collectVueComponents>;
      expect(capped).toMatchObject({
        status: 'partial',
        reason: 'limit',
        truncated: true,
      });
      expect(capped.nodes).toHaveLength(1024);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('preserves exact duplicate input membership and bounds malformed runtime parent cycles', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
      const page = await context.newPage();
      await page.goto(`${base}/true/`);
      await page.waitForFunction(() => Object.hasOwn(window, 'fixtureReady'));
      const duplicates = (await page.evaluate(`(() => {
        const [first, second] = document.querySelectorAll('b');
        return (${collector})([first, second, first]);
      })()`)) as ReturnType<typeof collectVueComponents>;
      expect(
        duplicates.nodes.filter((n) => n.name === 'RepeatedLeaf').map((n) => n.elements),
      ).toEqual([[0, 2], [1]]);
      const unsupported = await page.evaluate(`(() => {
        const root = document.querySelector('main').__vueParentComponent;
        const version = root.appContext.app.version;
        root.appContext.app.version = '2.7.0';
        const snapshot = (${collector})([document.querySelector('main')]);
        root.appContext.app.version = version;
        return snapshot;
      })()`);
      expect(unsupported).toMatchObject({
        status: 'unavailable',
        reason: 'unsupported_runtime',
        nodes: [],
      });
      const cycle = (await page.evaluate(`(() => {
        const root = document.querySelector('main').__vueParentComponent;
        const parent = root.parent;
        root.parent = root;
        const snapshot = (${collector})([document.querySelector('main')]);
        root.parent = parent;
        return snapshot;
      })()`)) as ReturnType<typeof collectVueComponents>;
      expect(cycle).toMatchObject({
        status: 'partial',
        reason: 'limit',
        truncated: true,
      });
      expect(cycle.nodes.find((n) => n.name === 'FixtureRoot')?.parent).toBeNull();
      await context.close();
    } finally {
      await browser.close();
    }
  });
  it('joins real Vue ownership to captured DOM and refuses an identical replacement', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const viewport = { width: 400, height: 300 };
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(`${base}/true/`);
      await page.waitForFunction(() => Object.hasOwn(window, 'fixtureReady'));
      const guard = await beginComponentCapture(page, false);
      const structure = (await captureStructure(page, viewport, []))!;
      const result = await finishComponentCapture(page, structure, guard, {
        scale: 1,
        origin: { x: 0, y: 0 },
      });
      const vue = result.trees.find((tree) => tree.framework === 'vue')!;
      expect(vue.status).toBe('available');
      const repeated = vue.nodes.filter((node) => node.name === 'RepeatedLeaf');
      expect(repeated).toHaveLength(2);
      expect(
        repeated.map((node) =>
          node.elements.map((index) => structure.elements[index]!.tag),
        ),
      ).toEqual([['b'], ['b']]);
      const beforePixels = await page.screenshot();
      const integrated = await captureStructure(
        page,
        viewport,
        [],
        undefined,
        1,
        { x: 0, y: 0 },
        true,
      );
      expect(
        integrated?.components?.trees.find((tree) => tree.framework === 'vue')?.status,
      ).toBe('available');
      const masked = await captureStructure(
        page,
        viewport,
        ['b'],
        undefined,
        1,
        { x: 0, y: 0 },
        true,
      );
      expect(
        masked?.components?.trees.every(
          (tree) => tree.reason === 'masked' && !tree.nodes.length,
        ),
      ).toBe(true);
      expect((await page.screenshot()).equals(beforePixels)).toBe(true);
      const guard2 = await beginComponentCapture(page, false);
      const structure2 = (await captureStructure(page, viewport, []))!;
      await page.evaluate(() => {
        const el = document.querySelector('b')!;
        el.replaceWith(el.cloneNode(true));
      });
      const changed = await finishComponentCapture(page, structure2, guard2, {
        scale: 1,
        origin: { x: 0, y: 0 },
      });
      expect(
        changed.trees.every(
          (tree) =>
            tree.status === 'unavailable' &&
            tree.reason === 'dom-changed' &&
            !tree.nodes.length,
        ),
      ).toBe(true);
      await context.close();
    } finally {
      await browser.close();
    }
  });
});
