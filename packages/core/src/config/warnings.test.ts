import { describe, expect, it } from 'vitest';
import { checkProjectSettle } from '../capture/settle-options.js';
import { configWarnings, storyParamWarnings } from './warnings.js';

describe('configWarnings', () => {
  it('names an unknown top-level key with the closest valid one', () => {
    expect(configWarnings({ concurency: 8 })).toEqual([
      "project config: unknown option 'concurency' is ignored (did you mean 'concurrency'?)",
    ]);
  });

  it('says nothing about a valid config, or $schema', () => {
    expect(
      configWarnings({
        $schema: 'https://example.com/schema.json',
        platform: 'storybook',
        storage: { kind: 'fs', dir: 'x' },
        variants: { dark: { colorScheme: 'dark' } },
      }),
    ).toEqual([]);
  });

  it('leaves out the suggestion when nothing is close', () => {
    expect(configWarnings({ zzzzzzzz: 1 })).toEqual([
      "project config: unknown option 'zzzzzzzz' is ignored",
    ]);
  });

  it('names where a nested unknown key is', () => {
    expect(
      configWarnings({
        variants: { dark: { colourScheme: 'dark' } },
        storage: { kind: 'git', dirr: 'x' },
        urls: [{ id: 'a', url: '/a', params: { dely: 5 } }],
        mcp: { concurrence: 2 },
      }),
    ).toEqual([
      "project config: urls[0].params: unknown option 'dely' is ignored (did you mean 'delay'?)",
      "project config: variants['dark']: unknown option 'colourScheme' is ignored (did you mean 'colorScheme'?)",
      "project config: storage: unknown option 'dirr' is ignored (did you mean 'dir'?)",
      "project config: mcp: unknown option 'concurrence' is ignored (did you mean 'concurrency'?)",
    ]);
  });

  it('only warns: the runtime still accepts the config', () => {
    const config = { concurency: 8, variants: { dark: { colourScheme: 'dark' } } };
    expect(() => checkProjectSettle(config)).not.toThrow();
    expect(configWarnings(config)).toHaveLength(2);
  });

  it('ignores a config that is not an object', () => {
    for (const c of [undefined, null, [], 'x', 5]) expect(configWarnings(c)).toEqual([]);
  });
});

describe('storyParamWarnings', () => {
  const capture = (storyId: string, params: unknown) => ({ storyId, params });

  it('reports each unknown key once, with how many more stories set it', () => {
    expect(
      storyParamWarnings([
        capture('a--one', { dely: 5 }),
        capture('a--two', { dely: 10, mask: ['.x'] }),
        capture('a--three', { delay: 1 }),
        capture('b--one', { skipp: true }),
      ]),
    ).toEqual([
      "story 'a--one' (and 1 more): unknown parameters.juxtapose option 'dely' is ignored (did you mean 'delay'?)",
      "story 'b--one': unknown parameters.juxtapose option 'skipp' is ignored (did you mean 'skip'?)",
    ]);
  });

  it('says nothing for valid params, including a variant capture', () => {
    expect(
      storyParamWarnings([
        capture('a--one', { delay: 1, settle: { timeout: 10 } }),
        capture('a--one__dark', { colorScheme: 'dark' }),
      ]),
    ).toEqual([]);
  });
});
