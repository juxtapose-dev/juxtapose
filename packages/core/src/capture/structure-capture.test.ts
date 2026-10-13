import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { expect, test, vi } from 'vitest';
import { captureStructure } from './structure.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '__fixtures__/structure-basic.cdp.json'),
    'utf8',
  ),
);
const viewport = fixture.viewport;

function fakePage(opts: {
  send?: () => Promise<unknown>;
  evaluate?: () => Promise<unknown>;
}) {
  const detach = vi.fn(async () => {});
  const evaluate = vi.fn(opts.evaluate ?? (async () => 0));
  const newCDPSession = vi.fn(async () => ({
    send: opts.send ?? (async () => fixture.raw),
    detach,
  }));
  const page = {
    evaluate,
    context: () => ({ newCDPSession }),
  } as unknown as Page;
  return { page, detach, evaluate, newCDPSession };
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

test('mask selectors are marked before and cleared after', async () => {
  const { page, evaluate } = fakePage({});
  await captureStructure(page, viewport, ['.clock']);
  // two evaluates: mark, then clear
  expect(evaluate).toHaveBeenCalledTimes(2);
});

test('mask marking failure returns undefined and never calls CDP', async () => {
  const { page, newCDPSession } = fakePage({
    evaluate: async () => {
      throw new Error('Execution context was destroyed');
    },
  });
  await expect(captureStructure(page, viewport, ['.secret'])).resolves.toBeUndefined();
  expect(newCDPSession).not.toHaveBeenCalled();
});
