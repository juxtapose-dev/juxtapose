import { expect, it, vi } from 'vitest';
import type { Page } from '../browser/page.js';
import { beginComponentCapture } from './components.js';
import { finishDomMappingGuard } from '../components/dom-mapping.js';

it('abandons the known guard when installation ran but its response rejects', async () => {
  let installed = false;
  const evaluate = vi.fn<Page['evaluate']>().mockResolvedValue(undefined);
  evaluate.mockImplementationOnce(async () => {
    installed = true;
    throw new Error('response lost after observer installation');
  });
  // Only evaluate is used by this boundary; the remaining Page methods are irrelevant.
  const page = { evaluate } as Page;
  expect(await beginComponentCapture(page, false)).toEqual({ reason: 'capture-failed' });
  expect(installed).toBe(true);
  expect(evaluate).toHaveBeenCalledTimes(2);
  const source = evaluate.mock.calls[0]?.[0];
  if (typeof source !== 'string') throw new Error('missing installation expression');
  const key = /"(jux_components_[a-f0-9]{32})"/.exec(source)?.[1];
  expect(key).toBeDefined();
  expect(evaluate.mock.calls[1]?.[0]).toBe(
    `(${finishDomMappingGuard.toString()})(document,${JSON.stringify(key)})`,
  );
});

it('keeps the diagnostic failure soft if cleanup also rejects', async () => {
  const evaluate = vi.fn<Page['evaluate']>().mockRejectedValue(new Error('private/path'));
  const result = await beginComponentCapture({ evaluate } as Page, false);
  expect(result).toEqual({ reason: 'capture-failed' });
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain('private/path');
});

it('skips all browser work when an active mask suppresses component capture', async () => {
  const evaluate = vi.fn<Page['evaluate']>();
  expect(await beginComponentCapture({ evaluate } as Page, true)).toEqual({
    reason: 'masked',
  });
  expect(evaluate).not.toHaveBeenCalled();
});

it('retains successful guards for normal capture completion', async () => {
  const evaluate = vi.fn<Page['evaluate']>().mockResolvedValue({ status: 'available' });
  expect(await beginComponentCapture({ evaluate } as Page, false)).toEqual({
    key: expect.stringMatching(/^jux_components_[a-f0-9]{32}$/),
  });
  expect(evaluate).toHaveBeenCalledOnce();
});
