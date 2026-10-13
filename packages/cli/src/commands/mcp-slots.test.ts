import { describe, it, expect } from 'vitest';
import { availableParallelism } from 'node:os';
import { MAX_SNAP_SLOTS, defaultSnapSlots, resolveSnapSlots } from './mcp.js';

describe('resolveSnapSlots', () => {
  it('defaults to half the cores, at least 1 and at most 4, with neither a flag nor config', () => {
    for (const [cores, slots] of [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [7, 3],
      [8, 4],
      [15, 4],
      [64, 4],
    ])
      expect(resolveSnapSlots(undefined, undefined, cores)).toEqual({ slots });
    expect(resolveSnapSlots(undefined, undefined)).toEqual({
      slots: defaultSnapSlots(availableParallelism()),
    });
  });
  it('names the default for this machine in the range error', () => {
    expect(resolveSnapSlots('0', undefined, 4)).toEqual({
      error: expect.stringContaining('(default 2)'),
    });
  });
  it('an explicit value is not capped by the core count', () => {
    expect(resolveSnapSlots('8', undefined, 2)).toEqual({ slots: 8 });
    expect(resolveSnapSlots(undefined, 16, 2)).toEqual({ slots: 16 });
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
