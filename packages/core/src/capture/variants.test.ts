// Variant expansion, live-param precedence and selection (spec
// 2026-10-13-variants-design.md). Pure functions; the real-Chrome half of the
// contract is in variants-capture.test.ts.

import { describe, expect, it } from 'vitest';
import type { StoryManifest, StoryParams, VariantSpec } from '../types.js';
import {
  expandVariants,
  mergeLiveParams,
  selectByStoryId,
  VariantConfigError,
} from './variants.js';

const story = (id: string, params: StoryParams = {}): StoryManifest => ({
  storyId: id,
  title: 'T',
  name: id,
  componentPath: `/src/${id}.stories.tsx`,
  params,
});

const keys = (out: StoryManifest[]) => out.map((s) => s.storyId);
const byKey = (out: StoryManifest[], key: string) => out.find((s) => s.storyId === key)!;

describe('expandVariants', () => {
  it('leaves stories without variants exactly as they were', () => {
    const input = [story('b', { delay: 5 }), story('a')];
    const out = expandVariants(input);
    expect(out).toEqual([story('a'), story('b', { delay: 5 })]);
    expect(out[0]).not.toHaveProperty('baseStoryId');
    expect(out[0]).not.toHaveProperty('variant');
  });

  it('emits the default capture plus one keyed entry per variant, code-unit sorted', () => {
    const out = expandVariants([
      story('btn', {
        variants: { mobile: { viewport: { width: 375, height: 812 } }, dark: {} },
      }),
      story('Btn'),
    ]);
    // Code units, not locale: 'B' < 'b', and '__' sorts after the bare id.
    expect(keys(out)).toEqual(['Btn', 'btn', 'btn__dark', 'btn__mobile']);
    const mobile = byKey(out, 'btn__mobile');
    expect(mobile.baseStoryId).toBe('btn');
    expect(mobile.variant).toBe('mobile');
    expect(mobile.componentPath).toBe('/src/btn.stories.tsx');
    expect(mobile.params).toEqual({ viewport: { width: 375, height: 812 } });
    // The declaration never reaches a capture.
    expect(byKey(out, 'btn').params).toEqual({});
  });

  it('applies project variants to every story, story wins by name, false opts out', () => {
    const project: Record<string, VariantSpec | false> = {
      dark: { colorScheme: 'dark', delay: 1 },
      mobile: { viewport: { width: 375, height: 812 } },
    };
    const out = expandVariants(
      [
        story('a'),
        story('b', { variants: { dark: { colorScheme: 'dark', delay: 9 } } }),
        story('c', { variants: { mobile: false } }),
      ],
      project,
    );
    expect(keys(out)).toEqual([
      'a',
      'a__dark',
      'a__mobile',
      'b',
      'b__dark',
      'b__mobile',
      'c',
      'c__dark',
    ]);
    expect(byKey(out, 'a__dark').params).toEqual({ colorScheme: 'dark', delay: 1 });
    expect(byKey(out, 'b__dark').params).toEqual({ colorScheme: 'dark', delay: 9 });
  });

  it('a project variant set to false is not a variant', () => {
    expect(keys(expandVariants([story('a')], { dark: false }))).toEqual(['a']);
  });

  it('a skipped story gets no variants', () => {
    const out = expandVariants([story('a', { skip: true })], { dark: {} });
    expect(keys(out)).toEqual(['a']);
  });

  it('merges base params, then the extends chain farthest-first, then the variant', () => {
    const out = expandVariants([
      story('s', {
        delay: 1,
        threshold: 0.1,
        captureTimeout: 100,
        variants: {
          base: { delay: 2, threshold: 0.2, viewport: { width: 1, height: 1 } },
          mid: { extends: 'base', threshold: 0.3 },
          top: { extends: 'mid', colorScheme: 'dark' },
        },
      }),
    ]);
    const top = byKey(out, 's__top');
    expect(top.params).toEqual({
      delay: 2,
      threshold: 0.3,
      captureTimeout: 100,
      viewport: { width: 1, height: 1 },
      colorScheme: 'dark',
    });
    expect(top.variantParams).toEqual({
      delay: 2,
      threshold: 0.3,
      viewport: { width: 1, height: 1 },
      colorScheme: 'dark',
    });
    expect(top.params).not.toHaveProperty('extends');
  });

  it('extends resolves across project and story variants', () => {
    const out = expandVariants(
      [
        story('s', {
          variants: { 'mobile-dark': { extends: 'mobile', colorScheme: 'dark' } },
        }),
      ],
      { mobile: { viewport: { width: 375, height: 812 } } },
    );
    expect(byKey(out, 's__mobile-dark').params).toEqual({
      viewport: { width: 375, height: 812 },
      colorScheme: 'dark',
    });
  });

  it('a story-level false removes the target of an extends: unknown', () => {
    expect(() =>
      expandVariants([story('s', { variants: { mobile: false } })], {
        mobile: {},
        'mobile-dark': { extends: 'mobile' },
      }),
    ).toThrow("story 's' variant 'mobile-dark' extends unknown variant 'mobile'");
  });

  it('an unknown extends is a config error naming story and variant', () => {
    const run = () =>
      expandVariants([story('s', { variants: { dark: { extends: 'nope' } } })]);
    expect(run).toThrow(VariantConfigError);
    expect(run).toThrow("story 's' variant 'dark' extends unknown variant 'nope'");
  });

  it('an extends cycle is a config error naming the cycle', () => {
    expect(() =>
      expandVariants([
        story('s', {
          variants: { a: { extends: 'b' }, b: { extends: 'c' }, c: { extends: 'a' } },
        }),
      ]),
    ).toThrow("story 's' variant 'a': extends cycle a -> b -> c -> a");
    expect(() =>
      expandVariants([story('s', { variants: { self: { extends: 'self' } } })]),
    ).toThrow(/extends cycle self -> self/);
  });

  it.each([
    ['Dark', false],
    ['dark_mode', false],
    ['-dark', false],
    ['', false],
    ['a'.repeat(33), false],
    ['dark', true],
    ['mobile-dark', true],
    ['2x', true],
    ['a'.repeat(32), true],
  ])('variant name %j valid: %s', (name, ok) => {
    const run = () => expandVariants([story('s', { variants: { [name]: {} } })]);
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(/variant name .* must match/);
  });

  it('validates project variant names too, naming the project config', () => {
    expect(() => expandVariants([story('s')], { Dark: {} })).toThrow(
      "jux: project config: variant name 'Dark' must match",
    );
  });

  it('rejects malformed specs', () => {
    const bad = (variants: unknown) => () =>
      expandVariants([story('s', { variants } as unknown as StoryParams)]);
    expect(bad({ dark: true })).toThrow(/must be an object of capture settings/);
    expect(bad({ dark: { colorScheme: 'black' } })).toThrow(/'light' or 'dark'/);
    expect(bad({ dark: { skip: true } })).toThrow(/set the variant to false/);
    expect(bad({ dark: { extends: 3 } })).toThrow(/extends must be a variant name/);
    expect(bad([])).toThrow(/must be an object of named variants/);
  });

  it('two captures sharing a key is a config error naming both', () => {
    // A Ladle key or url id may contain `__`, so a story can collide with
    // another story's variant.
    expect(() =>
      expandVariants([story('a', { variants: { b: {} } }), story('a__b')]),
    ).toThrow(
      "capture key 'a__b' is produced by both story 'a' variant 'b' and story 'a__b'",
    );
    expect(() => expandVariants([story('a'), story('a')])).toThrow(
      "capture key 'a' is produced by both story 'a' and story 'a'",
    );
  });

  it('a story-level colorScheme is ignored: the default capture is light', () => {
    const out = expandVariants([story('s', { colorScheme: 'dark' })]);
    expect(out[0]!.params).toEqual({});
  });

  it('does not mutate its input', () => {
    const input = story('s', { variants: { dark: { colorScheme: 'dark' } } });
    const snapshot = structuredClone(input);
    expandVariants([input], { mobile: {} });
    expect(input).toEqual(snapshot);
  });
});

describe('mergeLiveParams', () => {
  it('live params override manifest params on a default capture', () => {
    expect(
      mergeLiveParams(story('s', { threshold: 0.5, delay: 1 }), { threshold: 0.1 }),
    ).toEqual({ threshold: 0.1, delay: 1 });
  });

  it("merges under the variant: the story's live viewport can't undo the variant's", () => {
    const [, mobile] = expandVariants([
      story('s', {
        variants: {
          mobile: { viewport: { width: 375, height: 812 }, colorScheme: 'dark' },
        },
      }),
    ]);
    const merged = mergeLiveParams(mobile!, {
      viewport: { width: 480, height: 400 },
      threshold: 0.2,
      colorScheme: 'light',
    });
    expect(merged).toEqual({
      viewport: { width: 375, height: 812 },
      colorScheme: 'dark',
      threshold: 0.2,
    });
  });

  it('live params still fill in what the variant leaves unset', () => {
    const [, dark] = expandVariants([
      story('s', { variants: { dark: { colorScheme: 'dark' } } }),
    ]);
    expect(
      mergeLiveParams(dark!, { viewport: { width: 480, height: 400 } }).viewport,
    ).toEqual({
      width: 480,
      height: 400,
    });
  });

  it('drops the live variants declaration and colorScheme, and copies', () => {
    const s = story('s', { delay: 1 });
    const merged = mergeLiveParams(s, {
      variants: { dark: {} },
      colorScheme: 'dark',
      skip: true,
    });
    expect(merged).toEqual({ delay: 1, skip: true });
    expect(s.params).toEqual({ delay: 1 });
  });
});

describe('device layering', () => {
  const vp = { width: 800, height: 600 };

  it('a variant that sets device drops the story viewport', () => {
    const out = expandVariants([
      story('s', { viewport: vp, variants: { mobile: { device: 'mobile' } } }),
    ]);
    const params = byKey(out, 's__mobile').params;
    expect(params.device).toBe('mobile');
    expect(params).not.toHaveProperty('viewport');
    expect(byKey(out, 's').params.viewport).toEqual(vp);
  });

  it('a variant with both device and viewport keeps both', () => {
    const own = { width: 400, height: 700 };
    const out = expandVariants([
      story('s', {
        viewport: vp,
        variants: { mobile: { device: 'mobile', viewport: own } },
      }),
    ]);
    expect(byKey(out, 's__mobile').params).toMatchObject({
      device: 'mobile',
      viewport: own,
    });
  });

  it('live viewport does not survive under a variant that sets device', () => {
    const out = expandVariants([story('s', { variants: { m: { device: 'mobile' } } })]);
    const merged = mergeLiveParams(byKey(out, 's__m'), { viewport: vp });
    expect(merged.device).toBe('mobile');
    expect(merged).not.toHaveProperty('viewport');
  });

  it('a live device replaces the story viewport', () => {
    const merged = mergeLiveParams(story('s', { viewport: vp }), { device: 'tablet' });
    expect(merged).toEqual({ device: 'tablet' });
  });
});

describe('selectByStoryId', () => {
  const all = expandVariants([story('a'), story('b')], { dark: {}, mobile: {} });

  it('a base id selects the story and all its variants', () => {
    const { selected, unknown } = selectByStoryId(all, ['a']);
    expect(keys(selected)).toEqual(['a', 'a__dark', 'a__mobile']);
    expect(unknown).toEqual([]);
  });

  it('a capture key selects exactly one capture', () => {
    expect(keys(selectByStoryId(all, ['b__dark']).selected)).toEqual(['b__dark']);
    expect(keys(selectByStoryId(all, ['b__dark', 'a']).selected)).toEqual([
      'a',
      'a__dark',
      'a__mobile',
      'b__dark',
    ]);
  });

  it('reports ids that match nothing', () => {
    const { selected, unknown } = selectByStoryId(all, ['a__mobile', 'nope', 'a__nope']);
    expect(keys(selected)).toEqual(['a__mobile']);
    expect(unknown).toEqual(['nope', 'a__nope']);
  });
});

describe('deepEqual', () => {
  it('ignores key order, respects array order and types', async () => {
    const { deepEqual } = await import('./variants.js');
    expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual({ a: '1' }, { a: 1 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});
