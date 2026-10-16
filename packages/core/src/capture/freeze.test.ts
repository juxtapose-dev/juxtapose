import { describe, expect, it, vi } from 'vitest';
import type { Page } from '../browser/page.js';
import { applyFreeze, freezeChanged, resolveFreeze } from './freeze.js';

describe('freeze installation', () => {
  it('preserves the real clock and randomness unless explicitly enabled', () => {
    expect(resolveFreeze(undefined)).toEqual({
      clockMs: null,
      random: false,
      images: true,
    });
  });

  it('does not silently capture without a requested freeze when CDP installation fails', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('CDP disconnected'))
      .mockResolvedValue({ identifier: 'freeze-script' });
    const page = { send } as unknown as Page;
    const freeze = resolveFreeze({ clock: true });
    await expect(applyFreeze(page, freeze)).rejects.toThrow('CDP disconnected');
    await applyFreeze(page, freeze);
    expect(send).toHaveBeenCalledTimes(2);
    expect(freezeChanged(page, freeze)).toBe(false);
    expect(freezeChanged(page, resolveFreeze({ clock: false }))).toBe(true);
  });

  it('removes the old script when a later capture opts out', async () => {
    const send = vi.fn().mockResolvedValue({ identifier: 'freeze-script' });
    const page = { send } as unknown as Page;
    await applyFreeze(page, resolveFreeze({ random: true }));
    expect(await applyFreeze(page, resolveFreeze({ random: false }))).toBe(true);
    expect(send).toHaveBeenLastCalledWith('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: 'freeze-script',
    });
  });
});
