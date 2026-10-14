import { describe, expect, it } from 'vitest';
import type { StoryManifest } from '../types.js';
import { VariantConfigError } from './config-errors.js';
import {
  applyOverride,
  checkStoryOverrides,
  compileOverrides,
  resolveOverride,
  storyOverrideWarnings,
  withOverride,
} from './story-overrides.js';
import { expandVariants, mergeLiveParams } from './variants.js';
import { checkProjectSettle } from './settle-options.js';

const story = (id: string, params: StoryManifest['params'] = {}): StoryManifest => ({
  storyId: id,
  title: 'T',
  name: id,
  componentPath: '',
  params,
});

const resolve = (cfg: Record<string, object>, id: string, base?: string) =>
  resolveOverride(compileOverrides(cfg), {
    storyId: id,
    ...(base ? { baseStoryId: base } : {}),
  });

describe('matching', () => {
  it('matches exact ids and globs, and nothing else', () => {
    const cfg = {
      'a--one': { delay: 1 },
      'b--*': { delay: 2 },
      '**--clock': { delay: 3 },
    };
    expect(resolve(cfg, 'a--one')?.override.delay).toBe(1);
    expect(resolve(cfg, 'b--x')?.override.delay).toBe(2);
    expect(resolve(cfg, 'z--clock')?.override.delay).toBe(3);
    expect(resolve(cfg, 'a--two')).toBeUndefined();
    expect(resolve(cfg, 'a--one-more')).toBeUndefined();
  });

  it('a base-id key also matches that story variants', () => {
    const cfg = { 'a--one': { delay: 5 } };
    expect(resolve(cfg, 'a--one__mobile', 'a--one')?.override.delay).toBe(5);
  });

  it('a base__variant key matches only that capture', () => {
    const cfg = { 'a--one__mobile': { delay: 5 } };
    expect(resolve(cfg, 'a--one__mobile', 'a--one')?.override.delay).toBe(5);
    expect(resolve(cfg, 'a--one')).toBeUndefined();
    expect(resolve(cfg, 'a--one__dark', 'a--one')).toBeUndefined();
  });
});

describe('merge order among matching globs', () => {
  it('the more specific glob wins a scalar, regardless of file order', () => {
    const a = { 'a--*': { delay: 1 }, 'a--one': { delay: 2 } };
    const b = { 'a--one': { delay: 2 }, 'a--*': { delay: 1 } };
    expect(resolve(a, 'a--one')?.override.delay).toBe(2);
    expect(resolve(b, 'a--one')?.override.delay).toBe(2);
  });

  it('a longer literal part is more specific; equal specificity goes to the later key', () => {
    const cfg = { '*--one': { delay: 1 }, 'a--*': { delay: 2 } };
    expect(resolve(cfg, 'a--one')?.override.delay).toBe(1);
    const tie = { 'a-*': { delay: 1 }, '*-o': { delay: 2 } };
    expect(resolve(tie, 'a--o')?.override.delay).toBe(2);
    expect(
      resolve({ '*-o': { delay: 2 }, 'a-*': { delay: 1 } }, 'a--o')?.override.delay,
    ).toBe(1);
  });

  it('masks accumulate, settle merges, matched globs are listed least specific first', () => {
    const cfg = {
      'a--one': { mask: ['.x'], settle: { timeout: 900 } },
      'a--*': { mask: ['.y', '.x'], settle: { network: { ignore: ['/api/**'] } } },
    };
    const r = resolve(cfg, 'a--one')!;
    expect(r.override.mask).toEqual(['.y', '.x']);
    expect(r.override.settle).toEqual({
      timeout: 900,
      network: { ignore: ['/api/**'] },
    });
    expect(r.matched).toEqual(['a--*', 'a--one']);
  });
});

describe('applyOverride', () => {
  it('beats story params; masks union; skip:false un-skips', () => {
    const p = applyOverride(
      { delay: 10, mask: ['.s'], skip: true, settle: { timeout: 500 } },
      { delay: 99, mask: ['.c'], skip: false, settle: { ready: true } },
    );
    expect(p).toEqual({
      delay: 99,
      mask: ['.s', '.c'],
      skip: false,
      settle: { timeout: 500, ready: true },
    });
  });
});

describe('validation', () => {
  const bad = (cfg: unknown) => () => checkStoryOverrides(cfg);
  it('names the glob and key', () => {
    expect(bad({ 'a--*': { dely: 1 } })).toThrow(/stories\['a--\*'\].*unknown.*'dely'/s);
    expect(bad({ 'a--*': { skip: 'yes' } })).toThrow(/stories\['a--\*'\].*skip/);
    expect(bad({ 'a--*': { mask: '.x' } })).toThrow(/mask must be an array of selectors/);
    expect(bad({ 'a--*': { delay: -1 } })).toThrow(/delay/);
    expect(bad({ 'a--*': { captureTimeout: 0 } })).toThrow(/captureTimeout/);
    expect(bad({ 'a--*': { waitForSelector: 3 } })).toThrow(/waitForSelector/);
    expect(bad({ 'a--*': { threshold: 2 } })).toThrow(/threshold/);
    expect(bad({ 'a--*': { settle: { timeout: 'x' } } })).toThrow(
      /stories\['a--\*'\].*settle\.timeout/s,
    );
    expect(bad({ 'a--*': { network: { external: 'nope' } } })).toThrow(
      /network\.external/,
    );
    expect(bad({ '': {} })).toThrow(/empty/);
    expect(bad({ 'a--*': 5 })).toThrow(/must be an object/);
    expect(bad([])).toThrow(/'stories' must be an object/);
  });
  it('is a VariantConfigError and runs from checkProjectSettle', () => {
    expect(bad({ x: { delay: 'a' } })).toThrow(VariantConfigError);
    expect(() => checkProjectSettle({ stories: { x: { delay: 'a' } } })).toThrow(
      /project config: stories\['x'\]/,
    );
    expect(() =>
      checkProjectSettle({ stories: { 'a--*': { skip: true, mask: ['.x'] } } }),
    ).not.toThrow();
  });
});

describe('expandVariants with overrides', () => {
  const cfg = {
    'a--*': { mask: ['.clock'] },
    'a--gone': { skip: true },
    'a--one__mobile': { delay: 50 },
  };

  it('layers over story params and marks config skips', () => {
    const out = expandVariants(
      [story('a--one', { mask: ['.s'], delay: 1 }), story('a--gone'), story('b--x')],
      { mobile: { viewport: { width: 375, height: 800 } } },
      cfg,
    );
    const by = Object.fromEntries(out.map((s) => [s.storyId, s]));
    expect(by['a--one']!.params.mask).toEqual(['.s', '.clock']);
    expect(by['a--one']!.params.delay).toBe(1);
    expect(by['a--one__mobile']!.params.mask).toEqual(['.s', '.clock']);
    expect(by['a--one__mobile']!.params.delay).toBe(50);
    expect(by['a--one__mobile']!.params.viewport).toEqual({ width: 375, height: 800 });
    expect(by['a--gone']!.params.skip).toBe(true);
    expect(by['a--gone']!.skippedBy).toEqual(['a--gone']);
    expect(by['a--gone__mobile']).toBeUndefined();
    expect(by['b--x']!.override).toBeUndefined();
  });

  it('a variant-key skip drops only that capture, reported as skipped', () => {
    const out = expandVariants(
      [story('a--one')],
      { mobile: {}, dark: {} },
      { 'a--one__dark': { skip: true } },
    );
    const dark = out.find((s) => s.storyId === 'a--one__dark')!;
    expect(dark.params.skip).toBe(true);
    expect(dark.skippedBy).toEqual(['a--one__dark']);
    expect(out.find((s) => s.storyId === 'a--one__mobile')!.params.skip).not.toBe(true);
  });

  it('skip:false in config un-skips a story the source skips', () => {
    const out = expandVariants([story('a--one', { skip: true })], undefined, {
      'a--one': { skip: false },
    });
    expect(out[0]!.params.skip).toBe(false);
    expect(out[0]!.skippedBy).toBeUndefined();
  });

  it('live params cannot undo an override', () => {
    const [s] = expandVariants([story('a--one')], undefined, {
      'a--one': { delay: 7, mask: ['.c'], skip: false },
    });
    const merged = mergeLiveParams(s!, { delay: 1, mask: ['.l'], skip: true });
    expect(merged.delay).toBe(7);
    expect(merged.skip).toBe(false);
    expect(merged.mask).toEqual(['.l', '.c']);
  });
});

describe('review fixes', () => {
  it('a variant-targeting wildcard beats an exact base key on that variant (L4)', () => {
    const cfg = { 'a--one': { delay: 1 }, '*__mobile': { delay: 2 } };
    expect(resolve(cfg, 'a--one__mobile', 'a--one')?.override.delay).toBe(2);
    expect(resolve(cfg, 'a--one')?.override.delay).toBe(1);
    // An exact variant key still beats the variant wildcard.
    const exact = { 'a--one__mobile': { delay: 3 }, '*__mobile': { delay: 2 } };
    expect(resolve(exact, 'a--one__mobile', 'a--one')?.override.delay).toBe(3);
  });

  it('skippedBy is not set when the story already skips itself (L5)', () => {
    const compiled = compileOverrides({ 'a--*': { skip: true } });
    expect(
      withOverride(story('a--one'), { skip: true }, compiled).skippedBy,
    ).toBeUndefined();
    expect(withOverride(story('a--one'), {}, compiled).skippedBy).toEqual(['a--*']);
  });

  it('refuses Playwright-only selectors where they are declared (L6)', () => {
    expect(() => checkStoryOverrides({ a: { mask: ['text=x'] } })).toThrow(
      /stories\['a'\].*mask 'text=x'.*CSS selector/s,
    );
    expect(() => checkStoryOverrides({ a: { waitForSelector: 'a >> b' } })).toThrow(
      /waitForSelector/,
    );
    expect(() => checkStoryOverrides({ a: { mask: ['.ok'] } })).not.toThrow();
  });

  it('warns about keys that match nothing, and skip:false on a variant key (M3, M2)', () => {
    const caps = [
      { storyId: 'a--one' },
      { storyId: 'a--one__mobile', baseStoryId: 'a--one' },
    ];
    expect(
      storyOverrideWarnings(
        {
          'a--one': { delay: 1 },
          'a[': { delay: 1 },
          'typo--*': { skip: true },
          'a--one__mobile': { skip: false },
        },
        caps,
      ),
    ).toEqual([
      "stories['a['] matched no story",
      "stories['typo--*'] matched no story",
      expect.stringMatching(/stories\['a--one__mobile'\].*skip: false.*variant/s),
    ]);
    expect(storyOverrideWarnings(undefined, caps)).toEqual([]);
  });
});
