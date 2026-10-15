import { expect, test } from 'vitest';
import { resolveRenderer } from './renderer.js';
import { expandVariants, mergeLiveParams } from './variants.js';

test('fresh default, legacy mapping and forced approval/retry override', () => {
  expect(resolveRenderer()).toEqual({ shared: false, clearResourceCache: false });
  expect(resolveRenderer({ freshRenderer: false }).shared).toBe(true);
  expect(
    resolveRenderer({ renderer: { shared: true } }, { clearResourceCache: true }),
  ).toEqual({ shared: true, clearResourceCache: true });
  expect(
    resolveRenderer(
      { renderer: { shared: true } },
      { shared: true, clearResourceCache: true },
      true,
    ),
  ).toEqual({ shared: false, clearResourceCache: false });
  expect(() =>
    resolveRenderer({ freshRenderer: true, renderer: { shared: true } }),
  ).toThrow(/conflicts/);
});

test.each([{ shared: 'yes' }, { clearResourceCache: 1 }, { typo: false }, null])(
  'rejects invalid renderer settings %j',
  (renderer) => {
    expect(() => resolveRenderer({ renderer } as never)).toThrow();
  },
);

test('variants, matching globs and live params merge renderer fields', () => {
  const story = {
    storyId: 'card',
    title: 't',
    name: 'n',
    componentPath: '',
    params: {
      renderer: { shared: true, clearResourceCache: true },
      variants: { small: { renderer: { shared: false } } },
    },
  };
  const captures = expandVariants([story], undefined, {
    'card*': { renderer: { clearResourceCache: false } },
  });
  const variant = captures.find((s) => s.variant)!;
  expect(variant.params.renderer).toEqual({ shared: false, clearResourceCache: false });
  expect(
    mergeLiveParams(variant, { renderer: { shared: true, clearResourceCache: true } })
      .renderer,
  ).toEqual({ shared: false, clearResourceCache: false });
});
