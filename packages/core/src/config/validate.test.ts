// Message parity for the schema-driven validation (issue #178). Every row's
// expected message was produced by the hand-written validators this module
// replaced (origin/main at 0a8ef03, run through the built packages), so a
// change here is a change users see: the PR that makes it should say so.
import { describe, expect, it } from 'vitest';
import { checkNetwork } from '../capture/network-policy.js';
import {
  checkPatterns,
  checkProjectSettle,
  checkSettle,
} from '../capture/settle-options.js';
import { expandVariants } from '../capture/variants.js';
import type { StoryManifest } from '../types.js';

type Kind = 'project' | 'variants' | 'story' | 'settle' | 'network' | 'patterns';

const story = (params: unknown): StoryManifest =>
  ({ storyId: 'a--b', title: 'A', name: 'B', importPath: '', params }) as StoryManifest;

function run(kind: Kind, input: unknown, where?: string): void {
  switch (kind) {
    case 'project':
      return checkProjectSettle(input);
    case 'variants':
      expandVariants([story({})], input as never);
      return;
    case 'story':
      expandVariants([story(input)]);
      return;
    case 'settle':
      checkSettle(input, where!);
      return;
    case 'network':
      checkNetwork(input, where!);
      return;
    case 'patterns':
      // As `jux run --settle-ignore` reports it (cli/src/settle-flags.ts).
      checkPatterns(input, where!, (m) =>
        Object.assign(new Error(`jux run: ${m}`), { name: 'Usage' }),
      );
      return;
  }
}

/** [entry point, input, where, error class, message]. */
const INVALID: Array<[Kind, unknown, string | undefined, string, string]> = [
  [
    'project',
    { freshRenderer: 'no' },
    undefined,
    'SettleConfigError',
    'jux: project config: freshRenderer must be true or false, got "no"',
  ],
  [
    'project',
    { freshRenderer: 0 },
    undefined,
    'SettleConfigError',
    'jux: project config: freshRenderer must be true or false, got 0',
  ],
  [
    'project',
    { recheck: 'sometimes' },
    undefined,
    'SettleConfigError',
    'jux: project config: recheck must be "changed", "new" or "off", got "sometimes"',
  ],
  [
    'project',
    { recheck: true },
    undefined,
    'SettleConfigError',
    'jux: project config: recheck must be "changed", "new" or "off", got true',
  ],
  [
    'project',
    { storyTimeout: 0 },
    undefined,
    'SettleConfigError',
    'jux: project config: storyTimeout must be a whole number of ms, 1000 to 2147483647, got 0',
  ],
  [
    'project',
    { storyTimeout: 1.5 },
    undefined,
    'SettleConfigError',
    'jux: project config: storyTimeout must be a whole number of ms, 1000 to 2147483647, got 1.5',
  ],
  [
    'project',
    { storyTimeout: '60000' },
    undefined,
    'SettleConfigError',
    'jux: project config: storyTimeout must be a whole number of ms, 1000 to 2147483647, got "60000"',
  ],
  [
    'project',
    { storyTimeout: 2147483648 },
    undefined,
    'SettleConfigError',
    'jux: project config: storyTimeout must be a whole number of ms, 1000 to 2147483647, got 2147483648',
  ],
  [
    'project',
    { storyTimeout: 999 },
    undefined,
    'SettleConfigError',
    'jux: project config: storyTimeout must be a whole number of ms, 1000 to 2147483647, got 999',
  ],
  [
    'project',
    { waitForSelector: 5 },
    undefined,
    'SettleConfigError',
    'jux: project config: waitForSelector must be a CSS selector',
  ],
  [
    'project',
    { delay: -1 },
    undefined,
    'SettleConfigError',
    'jux: project config: delay must be a number of ms, 0 or more',
  ],
  [
    'project',
    { delay: '5' },
    undefined,
    'SettleConfigError',
    'jux: project config: delay must be a number of ms, 0 or more',
  ],
  [
    'project',
    { settle: 5 },
    undefined,
    'SettleConfigError',
    "jux: project config: 'settle' must be an object",
  ],
  [
    'project',
    { settle: [] },
    undefined,
    'SettleConfigError',
    "jux: project config: 'settle' must be an object",
  ],
  [
    'project',
    { settle: { wait: 1 } },
    undefined,
    'SettleConfigError',
    "jux: project config: unknown settle option 'wait' (expected timeout, ready, network)",
  ],
  [
    'project',
    { settle: { timeout: 0 } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.timeout must be a whole number of ms from 1 to 60000, got 0',
  ],
  [
    'project',
    { settle: { timeout: 60001 } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.timeout must be a whole number of ms from 1 to 60000, got 60001',
  ],
  [
    'project',
    { settle: { timeout: 1.5 } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.timeout must be a whole number of ms from 1 to 60000, got 1.5',
  ],
  [
    'project',
    { settle: { timeout: '100' } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.timeout must be a whole number of ms from 1 to 60000, got "100"',
  ],
  [
    'project',
    { settle: { ready: 'yes' } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.ready must be true or false, got "yes"',
  ],
  [
    'project',
    { settle: { network: [] } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.network must be an object',
  ],
  [
    'project',
    { settle: { network: 'x' } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.network must be an object',
  ],
  [
    'project',
    { settle: { network: { skip: [] } } },
    undefined,
    'SettleConfigError',
    "jux: project config: unknown settle.network option 'skip' (expected ignore, require)",
  ],
  [
    'project',
    { settle: { network: { ignore: 'x' } } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.network.ignore must be an array of URL patterns',
  ],
  [
    'project',
    { settle: { network: { ignore: [1] } } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.network.ignore must be an array of URL patterns',
  ],
  [
    'project',
    { settle: { network: { ignore: ['type:Nope'] } } },
    undefined,
    'SettleConfigError',
    "jux: project config: settle.network.ignore: pattern 'type:Nope': unknown resource type 'Nope' (one of Document, Stylesheet, Image, Media, Font, Script, TextTrack, XHR, Fetch, Prefetch, EventSource, WebSocket, Manifest, SignedExchange, Ping, CSPViolationReport, Preflight, FedCM, Other)",
  ],
  [
    'project',
    { settle: { network: { require: ['/a /b'] } } },
    undefined,
    'SettleConfigError',
    "jux: project config: settle.network.require: pattern '/a /b' has two URL globs; write one, or one pattern per glob",
  ],
  [
    'project',
    { settle: { network: { require: ['type:Fetch type:XHR'] } } },
    undefined,
    'SettleConfigError',
    "jux: project config: settle.network.require: pattern 'type:Fetch type:XHR' has two types",
  ],
  [
    'project',
    { settle: { network: { ignore: [''] } } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.network.ignore: a pattern must not be empty',
  ],
  [
    'project',
    { settle: { network: { ignore: ['   '] } } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.network.ignore: a pattern must not be empty',
  ],
  [
    'project',
    { network: 'block' },
    undefined,
    'SettleConfigError',
    "jux: project config: 'network' must be an object",
  ],
  [
    'project',
    { network: { externals: 'block' } },
    undefined,
    'SettleConfigError',
    "jux: project config: unknown network option 'externals' (expected external, rules)",
  ],
  [
    'project',
    { network: { external: 'deny' } },
    undefined,
    'SettleConfigError',
    "jux: project config: network.external must be 'allow' or 'block', or an object of per-type actions, got \"deny\"",
  ],
  [
    'project',
    { network: { external: true } },
    undefined,
    'SettleConfigError',
    "jux: project config: network.external must be 'allow' or 'block', or an object of per-type actions, got true",
  ],
  [
    'project',
    { stories: [] },
    undefined,
    'VariantConfigError',
    "jux: project config: 'stories' must be an object of story id globs",
  ],
  [
    'project',
    { stories: 'x' },
    undefined,
    'VariantConfigError',
    "jux: project config: 'stories' must be an object of story id globs",
  ],
  [
    'project',
    { stories: { '': {} } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['']: the story id glob must not be empty",
  ],
  [
    'project',
    { stories: { ' ': {} } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories[' ']: the story id glob must not be empty",
  ],
  [
    'project',
    { stories: { a: 5 } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: must be an object of capture settings",
  ],
  [
    'project',
    { stories: { a: [] } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: must be an object of capture settings",
  ],
  [
    'project',
    { stories: { x: { dely: 1 } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['x']: unknown option 'dely' (expected skip, mask, delay, waitForSelector, captureTimeout, settle, network, threshold, minDiffPercent)",
  ],
  [
    'project',
    { stories: { a: { skip: 'yes' } } },
    undefined,
    'VariantConfigError',
    'jux: project config: stories[\'a\']: skip must be true or false, got "yes"',
  ],
  [
    'project',
    { stories: { a: { mask: 'x' } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: mask must be an array of selectors",
  ],
  [
    'project',
    { stories: { a: { mask: [''] } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: mask must be an array of selectors",
  ],
  [
    'project',
    { stories: { a: { mask: [1] } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: mask must be an array of selectors",
  ],
  [
    'project',
    { stories: { a: { mask: ['text=foo'] } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: mask 'text=foo' is not a CSS selector (Playwright-only syntax is refused)",
  ],
  [
    'project',
    { stories: { a: { delay: -1 } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: delay must be a number of ms, 0 or more, got -1",
  ],
  [
    'project',
    { stories: { a: { delay: '5' } } },
    undefined,
    'VariantConfigError',
    'jux: project config: stories[\'a\']: delay must be a number of ms, 0 or more, got "5"',
  ],
  [
    'project',
    { stories: { a: { captureTimeout: 0 } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: captureTimeout must be a number of ms above 0, got 0",
  ],
  [
    'project',
    { stories: { a: { threshold: 2 } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: threshold must be a number from 0 to 1, got 2",
  ],
  [
    'project',
    { stories: { a: { minDiffPercent: 101 } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: minDiffPercent must be a percentage from 0 to 100, got 101",
  ],
  [
    'project',
    { stories: { a: { waitForSelector: '' } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: waitForSelector must be a CSS selector",
  ],
  [
    'project',
    { stories: { a: { waitForSelector: 5 } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: waitForSelector must be a CSS selector",
  ],
  [
    'project',
    { stories: { a: { waitForSelector: 'text=x' } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: waitForSelector 'text=x' is not a CSS selector (Playwright-only syntax is refused)",
  ],
  [
    'project',
    { stories: { a: { settle: 'x' } } },
    undefined,
    'SettleConfigError',
    "jux: project config: stories['a']: 'settle' must be an object",
  ],
  [
    'project',
    { stories: { a: { settle: { timeout: 0 } } } },
    undefined,
    'SettleConfigError',
    "jux: project config: stories['a']: settle.timeout must be a whole number of ms from 1 to 60000, got 0",
  ],
  [
    'project',
    { stories: { a: { settle: { network: { ignore: ['type:Nope'] } } } } },
    undefined,
    'SettleConfigError',
    "jux: project config: stories['a']: settle.network.ignore: pattern 'type:Nope': unknown resource type 'Nope' (one of Document, Stylesheet, Image, Media, Font, Script, TextTrack, XHR, Fetch, Prefetch, EventSource, WebSocket, Manifest, SignedExchange, Ping, CSPViolationReport, Preflight, FedCM, Other)",
  ],
  [
    'project',
    { stories: { a: { network: { external: 'x' } } } },
    undefined,
    'SettleConfigError',
    "jux: project config: stories['a']: network.external must be 'allow' or 'block', or an object of per-type actions, got \"x\"",
  ],
  [
    'project',
    { stories: { a: { network: { nope: 1 } } } },
    undefined,
    'SettleConfigError',
    "jux: project config: stories['a']: unknown network option 'nope' (expected external, rules)",
  ],
  [
    'project',
    { stories: { 'components-card--*': { dely: 1 } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['components-card--*']: unknown option 'dely' (expected skip, mask, delay, waitForSelector, captureTimeout, settle, network, threshold, minDiffPercent)",
  ],
  [
    'project',
    { freshRenderer: 'no', storyTimeout: 0 },
    undefined,
    'SettleConfigError',
    'jux: project config: freshRenderer must be true or false, got "no"',
  ],
  [
    'project',
    { delay: -1, settle: { timeout: 0 } },
    undefined,
    'SettleConfigError',
    'jux: project config: settle.timeout must be a whole number of ms from 1 to 60000, got 0',
  ],
  [
    'project',
    { stories: { a: { delay: -1, waitForSelector: '' } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: delay must be a number of ms, 0 or more, got -1",
  ],
  [
    'project',
    { stories: { a: { mask: ['text=foo', 1] } } },
    undefined,
    'VariantConfigError',
    "jux: project config: stories['a']: mask must be an array of selectors",
  ],
  [
    'project',
    { settle: { timeout: 0, wait: 1 } },
    undefined,
    'SettleConfigError',
    "jux: project config: unknown settle option 'wait' (expected timeout, ready, network)",
  ],
  [
    'variants',
    [],
    undefined,
    'VariantConfigError',
    "jux: project config: 'variants' must be an object of named variants",
  ],
  [
    'variants',
    'x',
    undefined,
    'VariantConfigError',
    "jux: project config: 'variants' must be an object of named variants",
  ],
  [
    'variants',
    { Bad_Name: {} },
    undefined,
    'VariantConfigError',
    "jux: project config: variant name 'Bad_Name' must match ^[a-z0-9][a-z0-9-]{0,31}$ (lowercase letters, digits and dashes; no underscores)",
  ],
  [
    'variants',
    { m: 5 },
    undefined,
    'VariantConfigError',
    "jux: project config: variant 'm' must be an object of capture settings, or false to opt out",
  ],
  [
    'variants',
    { m: true },
    undefined,
    'VariantConfigError',
    "jux: project config: variant 'm' must be an object of capture settings, or false to opt out",
  ],
  [
    'variants',
    { m: [] },
    undefined,
    'VariantConfigError',
    "jux: project config: variant 'm' must be an object of capture settings, or false to opt out",
  ],
  [
    'variants',
    { m: { skip: true } },
    undefined,
    'VariantConfigError',
    "jux: project config: variant 'm' sets 'skip'; set the variant to false instead",
  ],
  [
    'variants',
    { m: { skip: false } },
    undefined,
    'VariantConfigError',
    "jux: project config: variant 'm' sets 'skip'; set the variant to false instead",
  ],
  [
    'variants',
    { m: { colorScheme: 'blue' } },
    undefined,
    'VariantConfigError',
    "jux: project config: variant 'm' colorScheme must be 'light' or 'dark'",
  ],
  [
    'variants',
    { m: { settle: { timeout: 0 } } },
    undefined,
    'SettleConfigError',
    "jux: project config: variant 'm': settle.timeout must be a whole number of ms from 1 to 60000, got 0",
  ],
  [
    'variants',
    { m: { settle: 3 } },
    undefined,
    'SettleConfigError',
    "jux: project config: variant 'm': 'settle' must be an object",
  ],
  [
    'variants',
    { m: { network: { external: 'x' } } },
    undefined,
    'SettleConfigError',
    "jux: project config: variant 'm': network.external must be 'allow' or 'block', or an object of per-type actions, got \"x\"",
  ],
  [
    'variants',
    { m: { extends: 5 } },
    undefined,
    'VariantConfigError',
    "jux: project config: variant 'm' extends must be a variant name",
  ],
  [
    'variants',
    { Bad: {}, m: 5 },
    undefined,
    'VariantConfigError',
    "jux: project config: variant name 'Bad' must match ^[a-z0-9][a-z0-9-]{0,31}$ (lowercase letters, digits and dashes; no underscores)",
  ],
  [
    'story',
    { settle: { timeout: 0 } },
    undefined,
    'SettleConfigError',
    "jux: story 'a--b': settle.timeout must be a whole number of ms from 1 to 60000, got 0",
  ],
  [
    'story',
    { network: { external: 'x' } },
    undefined,
    'SettleConfigError',
    "jux: story 'a--b': network.external must be 'allow' or 'block', or an object of per-type actions, got \"x\"",
  ],
  [
    'story',
    { variants: { m: { colorScheme: 'x' } } },
    undefined,
    'VariantConfigError',
    "jux: story 'a--b': variant 'm' colorScheme must be 'light' or 'dark'",
  ],
  [
    'story',
    { variants: 'x' },
    undefined,
    'VariantConfigError',
    "jux: story 'a--b': 'variants' must be an object of named variants",
  ],
  [
    'settle',
    5,
    "'settle'",
    'SettleConfigError',
    "jux: 'settle': 'settle' must be an object",
  ],
  [
    'settle',
    { timeout: 0 },
    "'settle'",
    'SettleConfigError',
    "jux: 'settle': settle.timeout must be a whole number of ms from 1 to 60000, got 0",
  ],
  [
    'network',
    'x',
    "'network'",
    'SettleConfigError',
    "jux: 'network': 'network' must be an object",
  ],
  [
    'network',
    { external: 'x' },
    "'network'",
    'SettleConfigError',
    "jux: 'network': network.external must be 'allow' or 'block', or an object of per-type actions, got \"x\"",
  ],
  [
    'patterns',
    'x',
    '--settle-ignore',
    'Usage',
    'jux run: --settle-ignore must be an array of URL patterns',
  ],
  [
    'patterns',
    ['type:Nope'],
    '--settle-ignore',
    'Usage',
    "jux run: --settle-ignore: pattern 'type:Nope': unknown resource type 'Nope' (one of Document, Stylesheet, Image, Media, Font, Script, TextTrack, XHR, Fetch, Prefetch, EventSource, WebSocket, Manifest, SignedExchange, Ping, CSPViolationReport, Preflight, FedCM, Other)",
  ],
  [
    'patterns',
    [''],
    '--settle-require',
    'Usage',
    'jux run: --settle-require: a pattern must not be empty',
  ],
];

/** Inputs every entry point has always accepted, including keys the runtime
 *  does not check (the published schema is stricter; see config/schema.ts). */
const VALID: Array<[Kind, unknown]> = [
  ['project', {}],
  ['project', { platform: 'whatever', concurrency: 'x', viewport: 5, unknownKey: 1 }],
  [
    'project',
    { freshRenderer: false, storyTimeout: 1000, delay: 0, waitForSelector: '' },
  ],
  ['project', { storyTimeout: 2147483647, delay: 1.5 }],
  ['project', { settle: {}, network: {} }],
  [
    'project',
    {
      settle: {
        timeout: 60000,
        ready: false,
        network: { ignore: [], require: ['type:fetch /api/**'] },
      },
    },
  ],
  ['project', { network: { external: 'allow' } }],
  ['project', { stories: {} }],
  [
    'project',
    {
      stories: {
        'a--*': {
          skip: false,
          mask: ['img', '[data-x=y]'],
          delay: 0,
          captureTimeout: 1,
          threshold: 0,
          minDiffPercent: 100,
          waitForSelector: '.x',
          settle: { ready: true },
          network: { external: 'block' },
        },
      },
    },
  ],
  ['variants', {}],
  [
    'variants',
    {
      m: false,
      base: { viewport: 'anything' },
      dark: { colorScheme: 'dark', extends: 'base', foo: 1 },
    },
  ],
  ['story', { skip: 'not checked', variants: { m: { colorScheme: 'light' } } }],
];

describe('config validation messages', () => {
  it.each(INVALID)('%s %j', (kind, input, where, cls, message) => {
    let thrown: unknown;
    try {
      run(kind, input, where);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe(cls);
    expect((thrown as Error).message).toBe(message);
  });

  it.each(VALID)('accepts %s %j', (kind, input) => {
    expect(() => run(kind, input)).not.toThrow();
  });

  it('reports the first of several errors as the hand-written checks did, except within one stories entry', () => {
    // The one known difference: inside one `stories` entry the options are
    // checked in the order the "expected ..." list names them, where the old
    // checks did the numbers before waitForSelector, settle and network. Only
    // an entry with two bad options can tell; it used to name `threshold`.
    expect(() =>
      checkProjectSettle({ stories: { a: { waitForSelector: '', threshold: 2 } } }),
    ).toThrow(
      "jux: project config: stories['a']: waitForSelector must be a CSS selector",
    );
  });

  it('lets a config that is not an object through, as before', () => {
    for (const c of [[], 'x', 5]) expect(() => checkProjectSettle(c)).not.toThrow();
  });
});
