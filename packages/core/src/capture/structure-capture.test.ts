import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { Browser } from '../browser/browser.js';
import type { Page } from '../browser/page.js';
import { queryAllExpression } from '../browser/selectors.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { captureStructure, MASK_ATTR } from './structure.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '__fixtures__/structure-basic.cdp.json'),
    'utf8',
  ),
);
const viewport = fixture.viewport;

function fakePage(opts: {
  send?: () => Promise<unknown>;
  evaluateAll?: (sel: string, call: number) => Promise<unknown>;
}) {
  const calls: { sel: string; args: unknown[] }[] = [];
  const send = vi.fn(opts.send ?? (async () => fixture.raw));
  // Each mark/verify/unmark evaluate is `(function (els, a0) {…})((queryAll)("sel"), "arg")`:
  // queryAll's source ends in `}`, so the selector is the JSON string after
  // `})(`, and the evaluate's own arguments are the JSON values after it.
  // Both are parsed from the real expression, so a wrong attribute fails.
  const evaluate = vi.fn(async (expr: string) => {
    const m = /\}\)\(("(?:[^"\\]|\\.)*")\)((?:, "(?:[^"\\]|\\.)*")*)\)$/.exec(expr);
    const sel = m ? (JSON.parse(m[1]) as string) : '';
    const args = m?.[2] ? (JSON.parse(`[${m[2].slice(2)}]`) as unknown[]) : [];
    calls.push({ sel, args });
    return opts.evaluateAll ? opts.evaluateAll(sel, calls.length) : true;
  });
  const page = { evaluate, send } as unknown as Page;
  return { page, calls, send };
}

test('returns a normalized snapshot', async () => {
  const { page, send } = fakePage({});
  const s = await captureStructure(page, viewport, []);
  expect(s?.schema).toBe('juxtapose.structure/v1');
  expect(send).toHaveBeenCalledWith(
    'DOMSnapshot.captureSnapshot',
    expect.objectContaining({ includePaintOrder: true }),
  );
  // DOM rects are unused and make Chrome lay out content-visibility subtrees:
  // 2.6-4.9 s of a Primer TreeView capture (see captureStructure).
  const params = (send.mock.calls[0] as unknown[] | undefined)?.[1];
  expect(params).not.toHaveProperty('includeDOMRects');
});

test('a CDP failure yields undefined, never a throw', async () => {
  const { page } = fakePage({
    send: async () => {
      throw new Error('Target closed');
    },
  });
  await expect(captureStructure(page, viewport, [])).resolves.toBeUndefined();
});

test('masks are marked via queryAll, then unmarked by attribute', async () => {
  const { page, calls } = fakePage({
    // calls 1-2 mark (one match each), 3-4 verify, 5 unmarks
    evaluateAll: async (_sel, call) =>
      call <= 2 ? 1 : call <= 4 ? { total: 1, marked: 1 } : undefined,
  });
  await captureStructure(page, viewport, ['.clock', 'text=Now']);
  const marks = calls.filter((c) => c.args[0] === MASK_ATTR);
  expect(marks.map((c) => c.sel)).toEqual([
    '.clock',
    'text=Now',
    '.clock',
    'text=Now',
    `[${MASK_ATTR}]`,
  ]);
  expect(calls.at(-1)?.sel).toBe(`[${MASK_ATTR}]`);
});

test('a CDP failure with a mask still unmarks', async () => {
  const { page, calls } = fakePage({
    send: async () => {
      throw new Error('Target closed');
    },
  });
  await expect(captureStructure(page, viewport, ['.secret'])).resolves.toBeUndefined();
  expect(calls.at(-1)?.sel).toBe(`[${MASK_ATTR}]`);
});

test('mask marking failure returns undefined and never calls CDP', async () => {
  const { page, send, calls } = fakePage({
    evaluateAll: async (sel) => {
      if (sel === '.secret') throw new Error('Execution context was destroyed');
      return true;
    },
  });
  await expect(captureStructure(page, viewport, ['.secret'])).resolves.toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  expect(calls.at(-1)?.sel).toBe(`[${MASK_ATTR}]`);
});

test('a mark lost before the snapshot returned yields undefined', async () => {
  const { page } = fakePage({
    // call 1 marks, call 2 verifies
    evaluateAll: async (_sel, call) => (call === 2 ? false : undefined),
  });
  await expect(captureStructure(page, viewport, ['.secret'])).resolves.toBeUndefined();
});

test('a failing verification yields undefined', async () => {
  const { page } = fakePage({
    evaluateAll: async (_sel, call) => {
      if (call === 2) throw new Error('detached');
      return undefined;
    },
  });
  await expect(captureStructure(page, viewport, ['.secret'])).resolves.toBeUndefined();
});

test('a match that lost its mark and its selector match yields undefined', async () => {
  // Two elements marked; by verification one has dropped out of the selector
  // (and its mark), so `every` over the survivors alone would pass vacuously.
  const { page } = fakePage({
    evaluateAll: async (_sel, call) =>
      call === 1 ? 2 : call === 2 ? { total: 1, marked: 1 } : undefined,
  });
  await expect(captureStructure(page, viewport, ['.secret'])).resolves.toBeUndefined();
});

test('every marked match still marked and matching yields a snapshot', async () => {
  const { page } = fakePage({
    evaluateAll: async (_sel, call) =>
      call === 1 ? 2 : call === 2 ? { total: 2, marked: 2 } : undefined,
  });
  await expect(captureStructure(page, viewport, ['.secret'])).resolves.toMatchObject({
    schema: 'juxtapose.structure/v1',
  });
});

// Real Chrome: mark and verify resolve the selector through open shadow roots,
// as the screenshot mask does, so a masked element inside a component never
// leaks its text into the sidecar.
const chrome = chromeForTests();
const SHADOW_PAGE = `<!doctype html><body style="margin:0">
<div class="secret" style="width:40px;height:20px">LIGHT-SECRET</div>
<p>public</p>
<x-host></x-host>
<script>customElements.define('x-host', class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<div class="secret" style="width:30px;height:10px">SHADOW-SECRET</div>';
  }
});</script></body>`;

describe.skipIf(!chrome)('captureStructure on a real page', () => {
  let server: Server;
  let browser: Browser;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(SHADOW_PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    browser = await Browser.launch({ executablePath: chrome!.path });
  });
  afterAll(async () => {
    await browser?.close();
    server.closeAllConnections();
    server.close();
  });

  test('marks and verifies matches in the light DOM and an open shadow root, then unmarks', async () => {
    const ctx = await browser.newContext({ viewport: { width: 200, height: 100 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
      const s = await captureStructure(page, { width: 200, height: 100 }, ['.secret']);
      expect(s).toBeDefined();
      const masked = s!.elements.filter((e) => e.tag === 'masked');
      expect(masked.map((e) => e.rect)).toEqual([
        { x: 0, y: 0, w: 40, h: 20 },
        expect.objectContaining({ w: 30, h: 10 }),
      ]);
      expect(JSON.stringify(s)).not.toMatch(/SECRET/);
      expect(JSON.stringify(s)).toMatch(/public/);
      // Nothing left marked, in either tree.
      const left = await page.evaluate<number>(
        queryAllExpression(`[${MASK_ATTR}]`, 'return els.length;'),
      );
      expect(left).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});
