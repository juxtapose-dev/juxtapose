import { describe, expect, it } from 'vitest';
import { checkProjectSettle } from './settle-options.js';

describe('storyTimeout config', () => {
  it('accepts whole ms in range and absence', () => {
    expect(() => checkProjectSettle({})).not.toThrow();
    expect(() => checkProjectSettle({ storyTimeout: 1000 })).not.toThrow();
    expect(() => checkProjectSettle({ storyTimeout: 2 ** 31 - 1 })).not.toThrow();
  });
  it.each([0, -5, 999, 1.5, 3_000_000_000, 'abc', true, null, NaN])(
    'rejects %s, naming storyTimeout',
    (v) => {
      expect(() => checkProjectSettle({ storyTimeout: v })).toThrow(/storyTimeout/);
    },
  );
});
