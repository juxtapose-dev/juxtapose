import { describe, it, expect } from 'vitest';
import { MAX_SNAP_SLOTS, SNAP_SLOTS, resolveSnapSlots } from './mcp.js';

describe('resolveSnapSlots', () => {
  it('defaults to SNAP_SLOTS with neither a flag nor config', () => {
    expect(resolveSnapSlots(undefined, undefined)).toEqual({ slots: SNAP_SLOTS });
  });
  it('takes mcp.concurrency from the config', () => {
    expect(resolveSnapSlots(undefined, 8)).toEqual({ slots: 8 });
  });
  it('lets the flag override the config', () => {
    expect(resolveSnapSlots('2', 8)).toEqual({ slots: 2 });
  });
  it.each(['0', '17', '1.5', '-1', 'four', ''])('rejects --concurrency %j', (flag) => {
    expect(resolveSnapSlots(flag, undefined)).toEqual({
      error: expect.stringContaining('--concurrency'),
    });
  });
  it.each([0, MAX_SNAP_SLOTS + 1, 2.5, '4', null])('rejects mcp.concurrency %j', (v) => {
    expect(resolveSnapSlots(undefined, v)).toEqual({
      error: expect.stringContaining('mcp.concurrency'),
    });
  });
  it('accepts both bounds', () => {
    expect(resolveSnapSlots('1', undefined)).toEqual({ slots: 1 });
    expect(resolveSnapSlots(String(MAX_SNAP_SLOTS), undefined)).toEqual({
      slots: MAX_SNAP_SLOTS,
    });
  });
});
