import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '../browser/page.js';
import { expect, test, vi } from 'vitest';
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
  // Each mark/verify/unmark evaluate carries its selector as the
  // JSON-encoded argument of the queryAll call, `(function (selector) {…})("sel")`;
  // recover it for the assertions.
  const evaluate = vi.fn(async (expr: string) => {
    const m = /\}\)\(("(?:[^"\\]|\\.)*")\)/.exec(expr);
    const sel = m ? (JSON.parse(m[1]) as string) : '';
    calls.push({ sel, args: [MASK_ATTR] });
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
    expect.objectContaining({ includeDOMRects: true }),
  );
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
