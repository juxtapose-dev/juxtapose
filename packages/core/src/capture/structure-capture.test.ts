import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
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
  const detach = vi.fn(async () => {});
  const calls: { sel: string; args: unknown[] }[] = [];
  const evaluateAll = vi.fn(async (sel: string, ...args: unknown[]) => {
    calls.push({ sel, args });
    return opts.evaluateAll ? opts.evaluateAll(sel, calls.length) : true;
  });
  const locator = vi.fn((sel: string) => ({
    evaluateAll: (_fn: unknown, ...args: unknown[]) => evaluateAll(sel, ...args),
  }));
  const newCDPSession = vi.fn(async () => ({
    send: opts.send ?? (async () => fixture.raw),
    detach,
  }));
  const page = {
    locator,
    context: () => ({ newCDPSession }),
  } as unknown as Page;
  return { page, detach, calls, newCDPSession };
}

test('returns a normalized snapshot and detaches the session', async () => {
  const { page, detach } = fakePage({});
  const s = await captureStructure(page, viewport, []);
  expect(s?.schema).toBe('juxtapose.structure/v1');
  expect(detach).toHaveBeenCalled();
});

test('a CDP failure yields undefined, never a throw', async () => {
  const { page } = fakePage({
    send: async () => {
      throw new Error('Target closed');
    },
  });
  await expect(captureStructure(page, viewport, [])).resolves.toBeUndefined();
});

test('masks are marked via locators, then unmarked by attribute', async () => {
  const { page, calls } = fakePage({});
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
  const { page, newCDPSession, calls } = fakePage({
    evaluateAll: async (sel) => {
      if (sel === '.secret') throw new Error('Execution context was destroyed');
      return true;
    },
  });
  await expect(captureStructure(page, viewport, ['.secret'])).resolves.toBeUndefined();
  expect(newCDPSession).not.toHaveBeenCalled();
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
