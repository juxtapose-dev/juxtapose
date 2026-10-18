// `jux config --explain`: values are the real merge result, sources come from
// the trace the merge functions fill in. Each layer, and the ways they stack.

import { describe, expect, it } from 'vitest';
import type { Page } from '../browser/page.js';
import type { Platform } from '../platform.js';
import type { RecheckMode } from '../config/schema.js';
import type { ProjectConfig, StoryManifest, StoryParams } from '../types.js';
import { DEFAULT_VIEWPORT } from '../run/run.js';
import { explainCapture, findCaptures, liveReader, type Explanation } from './explain.js';
import { ProvenanceLog } from './provenance.js';
import { expandVariants, mergeLiveParams } from './variants.js';

const story = (id: string, params: StoryParams = {}): StoryManifest => ({
  storyId: id,
  title: 'T',
  name: id,
  componentPath: '',
  params,
});

function explain(
  stories: StoryManifest[],
  id: string,
  config: ProjectConfig = {},
  extra: {
    call?: Parameters<typeof explainCapture>[2]['call'];
    live?: StoryParams;
    recheck?: RecheckMode;
  } = {},
): Explanation {
  const log = new ProvenanceLog();
  const captures = expandVariants(stories, config.variants, config.stories, log);
  const found = findCaptures(captures, id)!;
  return explainCapture(found.capture, log, { config, ...extra }, found.variants);
}

const row = (e: Explanation, setting: string) =>
  e.settings.find((s) => s.setting === setting);
const src = (e: Explanation, setting: string) =>
  row(e, setting)?.source.map((s) => (s.detail ? `${s.layer}:${s.detail}` : s.layer));

describe('explainCapture', () => {
  it('shows the recheck mode and the layer that set it', () => {
    const dflt = explain([story('a')], 'a');
    expect(row(dflt, 'recheck')).toMatchObject({ value: 'changed' });
    expect(src(dflt, 'recheck')).toEqual(['default']);
    const proj = explain([story('a')], 'a', { recheck: 'new' });
    expect(row(proj, 'recheck')).toMatchObject({ value: 'new' });
    expect(src(proj, 'recheck')).toEqual(['project']);
    const cli = explain([story('a')], 'a', { recheck: 'new' }, { recheck: 'off' });
    expect(row(cli, 'recheck')).toMatchObject({ value: 'off' });
    expect(src(cli, 'recheck')).toEqual(['cli']);
  });

  it('names a default for what no layer sets', () => {
    const e = explain([story('a')], 'a');
    expect(row(e, 'settle.timeout')).toMatchObject({ value: 1500 });
    expect(src(e, 'settle.timeout')).toEqual(['default']);
    expect(row(e, 'viewport')?.value).toEqual(DEFAULT_VIEWPORT);
    expect(row(e, 'network.external.default')).toMatchObject({ value: 'allow' });
    expect(e.skipped).toBe(false);
  });

  it('shows freeze per field: defaults, project, a stories override, the story', () => {
    const dflt = explain([story('a')], 'a');
    expect(row(dflt, 'freeze.clock')).toMatchObject({
      value: false,
    });
    expect(src(dflt, 'freeze.clock')).toEqual(['default']);
    expect(row(dflt, 'freeze.random')).toMatchObject({ value: false });
    expect(row(dflt, 'freeze.images')).toMatchObject({ value: true });
    const e = explain([story('a', { freeze: { clock: false } })], 'a', {
      freeze: { random: false, images: false, clock: '2030-01-01' },
      stories: { a: { freeze: { random: true } } },
    });
    expect(row(e, 'freeze.clock')).toMatchObject({ value: false });
    expect(src(e, 'freeze.clock')).toEqual(['story']);
    expect(row(e, 'freeze.random')).toMatchObject({ value: true });
    expect(src(e, 'freeze.random')).toEqual(['stories:a']);
    expect(row(e, 'freeze.images')).toMatchObject({ value: false });
    expect(src(e, 'freeze.images')).toEqual(['project']);
  });

  it('notes a live freeze, which is read too late to apply', () => {
    const e = explain([story('a')], 'a', {}, { live: { freeze: { clock: true } } });
    expect(row(e, 'freeze.clock')).toMatchObject({ value: false });
    expect(e.notes.join('\n')).toMatch(/live parameters set freeze .*ignored/);
  });

  it('project config is the lowest layer', () => {
    const e = explain([story('a')], 'a', {
      viewport: { width: 800, height: 600 },
      delay: 50,
      threshold: 0.3,
      settle: { timeout: 3000 },
    });
    expect(src(e, 'viewport')).toEqual(['project']);
    expect(row(e, 'viewport')?.value).toEqual({ width: 800, height: 600 });
    expect(src(e, 'delay')).toEqual(['project']);
    expect(src(e, 'threshold')).toEqual(['project']);
    expect(row(e, 'settle.timeout')).toMatchObject({ value: 3000 });
    expect(src(e, 'settle.timeout')).toEqual(['project']);
  });

  it('story parameters beat the project, field by field for settle', () => {
    const e = explain([story('a', { delay: 10, settle: { ready: true } })], 'a', {
      delay: 50,
      settle: { timeout: 3000, ready: false },
    });
    expect(row(e, 'delay')?.value).toBe(10);
    expect(src(e, 'delay')).toEqual(['story']);
    expect(row(e, 'settle.timeout')?.value).toBe(3000);
    expect(src(e, 'settle.timeout')).toEqual(['project']);
    expect(row(e, 'settle.ready')?.value).toBe(true);
    expect(src(e, 'settle.ready')).toEqual(['story']);
  });

  it('a stories override beats the story and names every glob that set the value', () => {
    const e = explain(
      [story('btn--primary', { delay: 10, mask: ['.clock'] })],
      'btn--primary',
      { stories: { 'btn--*': { delay: 200 }, '*': { mask: ['.ad'], delay: 5 } } },
    );
    expect(row(e, 'delay')?.value).toBe(200);
    expect(src(e, 'delay')).toEqual(['stories:btn--*']);
    expect(row(e, 'mask')?.value).toEqual(['.clock', '.ad']);
    expect(src(e, 'mask')).toEqual(['story', 'stories:*']);
    expect(e.matched.stories).toEqual(['*', 'btn--*']);
  });

  it('a variant beats the story; its extends chain is named', () => {
    const e = explain(
      [
        story('a', {
          viewport: { width: 1000, height: 700 },
          delay: 1,
          variants: {
            dark: { colorScheme: 'dark', delay: 7 },
            mobile: { extends: 'dark', viewport: { width: 375, height: 800 } },
          },
        }),
      ],
      'a__mobile',
    );
    expect(e.baseStoryId).toBe('a');
    expect(e.variant).toBe('mobile');
    expect(e.extends).toEqual(['dark']);
    expect(row(e, 'viewport')?.value).toEqual({ width: 375, height: 800 });
    expect(src(e, 'viewport')).toEqual(['variant:mobile (story parameters)']);
    expect(row(e, 'colorScheme')?.value).toBe('dark');
    expect(src(e, 'colorScheme')).toEqual([
      'variant:dark (story parameters), extended by mobile',
    ]);
    expect(row(e, 'delay')?.value).toBe(7);
    expect(src(e, 'delay')).toEqual([
      'variant:dark (story parameters), extended by mobile',
    ]);
  });

  it('shows the resolved device, its size and the layer that set it', () => {
    const config = { variants: { mobile: { device: 'mobile' } } };
    const stories = [story('a', { viewport: { width: 800, height: 600 } })];
    const base = explain(stories, 'a', config);
    const m = explain(stories, 'a__mobile', config);
    expect(row(base, 'device')).toBeUndefined();
    expect(row(m, 'device')?.value).toBe('mobile (iphone-15, 393x852 portrait)');
    expect(src(m, 'device')).toEqual(['variant:mobile (project config)']);
    expect(row(m, 'viewport')?.value).toEqual({ width: 393, height: 852 });
    expect(src(m, 'viewport')).toEqual(['variant:mobile (project config)']);
  });

  it('the viewport row names the device layer when the device sets the size', () => {
    const e = explain([story('a', { device: 'ipad' })], 'a');
    expect(row(e, 'viewport')?.value).toEqual({ width: 810, height: 1080 });
    expect(src(e, 'viewport')).toEqual(src(e, 'device'));
    expect(src(e, 'viewport')).toEqual(['story']);
  });

  it('a project device and orientation apply to every story', () => {
    const e = explain([story('a')], 'a', { device: 'pixel-8', orientation: 'landscape' });
    expect(row(e, 'device')?.value).toBe('pixel-8 (915x412 landscape)');
    expect(src(e, 'device')).toEqual(['project']);
    expect(row(e, 'viewport')?.value).toEqual({ width: 915, height: 412 });
  });

  // The project viewport is the size when nothing sets a device, so a project
  // device supplies the size, as captureStory does.
  it('a project device sizes the capture over the project viewport', () => {
    const e = explain([story('a')], 'a', {
      viewport: { width: 800, height: 600 },
      device: 'pixel-8',
    });
    expect(row(e, 'viewport')?.value).toEqual({ width: 412, height: 915 });
    expect(src(e, 'viewport')).toEqual(['project']);
    expect(row(e, 'device')?.value).toBe('pixel-8 (412x915 portrait)');
    expect(src(e, 'device')).toEqual(['project']);
  });

  it('a project orientation rotates the project viewport', () => {
    const e = explain([story('a')], 'a', {
      viewport: { width: 800, height: 600 },
      orientation: 'portrait',
    });
    expect(row(e, 'viewport')?.value).toEqual({ width: 600, height: 800 });
    expect(row(e, 'orientation')?.value).toBe('portrait');
    expect(src(e, 'orientation')).toEqual(['project']);
  });

  it("a story viewport overrides a project device's size", () => {
    const e = explain([story('a', { viewport: { width: 500, height: 700 } })], 'a', {
      viewport: { width: 800, height: 600 },
      device: 'pixel-8',
    });
    expect(row(e, 'viewport')?.value).toEqual({ width: 500, height: 700 });
    expect(src(e, 'viewport')).toEqual(['story']);
  });

  it('says where a project variant was declared', () => {
    const e = explain([story('a')], 'a__tablet', {
      variants: { tablet: { viewport: { width: 768, height: 1024 } } },
    });
    expect(src(e, 'viewport')).toEqual(['variant:tablet (project config)']);
  });

  it('lists variant keys on the base story', () => {
    const e = explain([story('a', { variants: { b: {}, a: {} } })], 'a');
    expect(e.variants).toEqual(['a__a', 'a__b']);
    expect(e.variant).toBeUndefined();
  });

  it('a stories override beats the variant, and settle merges across all three', () => {
    const e = explain(
      [
        story('a', {
          settle: { network: { ignore: ['/story'] } },
          variants: {
            v: { settle: { timeout: 2000, network: { ignore: ['/variant'] } } },
          },
        }),
      ],
      'a__v',
      {
        settle: { network: { ignore: ['/project'] } },
        stories: { a__v: { settle: { timeout: 4000 } } },
      },
    );
    expect(row(e, 'settle.timeout')?.value).toBe(4000);
    expect(src(e, 'settle.timeout')).toEqual(['stories:a__v']);
    expect(row(e, 'settle.network.ignore')?.value).toEqual([
      '/project',
      '/story',
      '/variant',
    ]);
    expect(src(e, 'settle.network.ignore')).toEqual([
      'project',
      'story',
      'variant:v (story parameters)',
    ]);
  });

  it('live params beat the story but not the variant or the stories override', () => {
    const live: StoryParams = {
      delay: 99,
      waitForSelector: '#live',
      viewport: { width: 1, height: 1 },
      settle: { timeout: 500 },
    };
    const e = explain(
      [
        story('a', {
          delay: 1,
          variants: { m: { viewport: { width: 375, height: 800 } } },
        }),
      ],
      'a__m',
      { stories: { a: { delay: 300 } } },
      { live },
    );
    expect(row(e, 'delay')?.value).toBe(300);
    expect(src(e, 'delay')).toEqual(['stories:a']);
    expect(row(e, 'viewport')?.value).toEqual({ width: 375, height: 800 });
    expect(src(e, 'viewport')).toEqual(['variant:m (story parameters)']);
    expect(row(e, 'waitForSelector')?.value).toBe('#live');
    expect(src(e, 'waitForSelector')).toEqual(['live']);
    expect(row(e, 'settle.timeout')?.value).toBe(500);
    expect(src(e, 'settle.timeout')).toEqual(['live']);
  });

  it('live params replace the story settle whole, and the variant settle merges over them', () => {
    const e = explain(
      [
        story('a', {
          settle: { ready: true },
          variants: { v: { settle: { timeout: 2500 } } },
        }),
      ],
      'a__v',
      {},
      { live: { settle: { network: { ignore: ['/live'] } } } },
    );
    // The story's settle.ready is gone: live replaced it, as captureStory does.
    expect(row(e, 'settle.ready')?.value).toBe(false);
    expect(src(e, 'settle.ready')).toEqual(['default']);
    expect(src(e, 'settle.network.ignore')).toEqual(['live']);
    expect(src(e, 'settle.timeout')).toEqual(['variant:v (story parameters)']);
  });

  it('call flags beat every other layer', () => {
    const e = explain(
      [story('a', { settle: { timeout: 2000 } })],
      'a',
      { settle: { timeout: 3000 }, stories: { a: { settle: { timeout: 4000 } } } },
      {
        call: { settle: { timeout: 9000 }, network: { external: 'block' } },
        live: { settle: { timeout: 500 } },
      },
    );
    expect(row(e, 'settle.timeout')?.value).toBe(9000);
    expect(src(e, 'settle.timeout')).toEqual(['cli']);
    expect(row(e, 'network.external.default')?.value).toBe('block');
    expect(src(e, 'network.external.default')).toEqual(['cli']);
  });

  it('reports a skip from the config and who asked for it', () => {
    const e = explain([story('a', { variants: { v: {} } })], 'a', {
      stories: { a: { skip: true } },
    });
    expect(e.skipped).toBe(true);
    expect(src(e, 'skip')).toEqual(['stories:a']);
  });

  it('warns about a live network.external it cannot honour', () => {
    const e = explain(
      [story('a')],
      'a',
      {},
      { live: { network: { external: 'block' } } },
    );
    expect(row(e, 'network.external.default')?.value).toBe('allow');
    expect(e.notes[0]).toContain('live parameters set network');
  });

  it('agrees with mergeLiveParams on every value', () => {
    const stories = [
      story('a', {
        delay: 1,
        mask: ['.x'],
        variants: { v: { delay: 2, settle: { timeout: 2000 } } },
      }),
    ];
    const config: ProjectConfig = { stories: { 'a*': { mask: ['.y'] } } };
    const live: StoryParams = { delay: 3, settle: { ready: true } };
    const log = new ProvenanceLog();
    const [, v] = expandVariants(stories, undefined, config.stories, log);
    const real = mergeLiveParams(v!, live);
    const e = explainCapture(v!, log, { config, live });
    expect(row(e, 'delay')?.value).toBe(real.delay);
    expect(row(e, 'mask')?.value).toEqual(real.mask);
    expect(row(e, 'settle.timeout')?.value).toBe(real.settle?.timeout);
    expect(row(e, 'settle.ready')?.value).toBe(real.settle?.ready);
  });

  it('threads no trace by default: expansion is identical with and without one', () => {
    const stories = [story('a', { delay: 1, variants: { v: { delay: 2 } } })];
    const config: ProjectConfig = { stories: { a: { mask: ['.y'] } } };
    expect(
      expandVariants(stories, undefined, config.stories, new ProvenanceLog()),
    ).toEqual(expandVariants(stories, undefined, config.stories));
  });
});

describe('liveReader', () => {
  it('shows the story under its platform id and returns what the platform reads', async () => {
    const calls: string[] = [];
    const platform = {
      name: 'fake',
      showStory: async (_p: Page, id: string) => void calls.push(`show ${id}`),
      settle: async () => void calls.push('settle'),
      readLiveParams: async (_p: Page, id: string) => {
        calls.push(`read ${id}`);
        return { delay: 42 };
      },
    } as unknown as Platform;
    const read = liveReader(platform, async () => ({}) as Page, 'http://x')!;
    const [, v] = expandVariants([story('a', { variants: { v: {} } })]);
    expect(await read(v!)).toEqual({ delay: 42 });
    expect(calls).toEqual(['show a', 'settle', 'read a']);
  });

  it('is absent for a platform without live params', () => {
    expect(liveReader({ name: 'x' } as Platform, async () => ({}) as Page, '')).toBe(
      undefined,
    );
  });
});

describe('live params that repeat the story', () => {
  it('keep the layer that first set the value (Storybook reports discovery again)', () => {
    const own: StoryParams = { viewport: { width: 480, height: 400 }, delay: 5 };
    const e = explain(
      [story('a', own)],
      'a',
      {},
      { live: { ...own, waitForSelector: '#only-live' } },
    );
    expect(src(e, 'viewport')).toEqual(['story']);
    expect(src(e, 'delay')).toEqual(['story']);
    expect(src(e, 'waitForSelector')).toEqual(['live']);
  });
});

describe('network', () => {
  it('shows each type with its layer and the rules in evaluation order', () => {
    const e = explain(
      [
        story('a', {
          network: {
            external: { images: 'placeholder' },
            rules: [{ match: '**/story/**', action: 'allow' }],
          },
        }),
      ],
      'a',
      {
        network: {
          external: 'block',
          rules: [{ match: '**/project/**', action: 'block' }],
        },
        stories: {
          a: { network: { rules: [{ match: '**/glob/**', action: 'block' }] } },
        },
      },
      {
        call: { network: { external: { frames: 'placeholder' } } },
        callLayer: 'mcp',
      },
    );
    expect(row(e, 'network.external.default')?.value).toBe('block');
    expect(src(e, 'network.external.default')).toEqual(['project']);
    expect(row(e, 'network.external.images')?.value).toBe('placeholder');
    expect(src(e, 'network.external.images')).toEqual(['story']);
    expect(src(e, 'network.external.frames')).toEqual(['mcp']);
    // Higher layers first: the call, then stories globs, then the story, then the project.
    expect(e.matched.networkRules).toEqual([
      { match: '**/glob/**', action: 'block', source: { layer: 'stories', detail: 'a' } },
      { match: '**/story/**', action: 'allow', source: { layer: 'story' } },
      { match: '**/project/**', action: 'block', source: { layer: 'project' } },
    ]);
  });

  it('a string external over an object clears the lower layers per-type entries', () => {
    const e = explain([story('a', { network: { external: 'allow' } })], 'a', {
      network: { external: { images: 'block' } },
    });
    expect(row(e, 'network.external.images')).toBeUndefined();
    expect(src(e, 'network.external.default')).toEqual(['story']);
  });

  it('a variant merges its rules ahead of the story rules', () => {
    const e = explain(
      [
        story('a', {
          network: { rules: [{ match: '/s', action: 'allow' }] },
          variants: { v: { network: { rules: [{ match: '/v', action: 'block' }] } } },
        }),
      ],
      'a__v',
    );
    expect(e.matched.networkRules.map((r) => [r.match, r.source.layer])).toEqual([
      ['/v', 'variant'],
      ['/s', 'story'],
    ]);
  });
});

describe('reviewed edge cases', () => {
  it('labels the call layer by caller', () => {
    const call = { settle: { timeout: 7000 } };
    expect(src(explain([story('a')], 'a', {}, { call }), 'settle.timeout')).toEqual([
      'cli',
    ]);
    expect(
      src(explain([story('a')], 'a', {}, { call, callLayer: 'mcp' }), 'settle.timeout'),
    ).toEqual(['mcp']);
  });

  it('settings read before live params ignore live values and say so', () => {
    const e = explain(
      [story('a', { captureTimeout: 100 })],
      'a',
      {},
      {
        live: {
          captureTimeout: 9000,
          animations: 'play',
          captureAfterPlay: true,
          threshold: 0.5,
        },
      },
    );
    expect(row(e, 'captureTimeout')?.value).toBe(100);
    expect(src(e, 'captureTimeout')).toEqual(['story']);
    expect(row(e, 'animations')).toBeUndefined();
    expect(row(e, 'threshold')?.value).toBe(0.1);
    for (const k of ['captureTimeout', 'animations', 'captureAfterPlay', 'threshold'])
      expect(e.notes.some((n) => n.includes(`set ${k} `))).toBe(true);
  });

  it('a live variants opt-out is a skip, from live params', () => {
    const e = explain(
      [story('a', { variants: { v: {} } })],
      'a__v',
      {},
      { live: { variants: { v: false } } },
    );
    expect(e.skipped).toBe(true);
    expect(row(e, 'skip')?.value).toBe(true);
    expect(e.settings.find((s) => s.setting === 'skip')?.source[0]?.layer).toBe('live');
  });

  it('live repeating the story keeps the story as source under a stories override', () => {
    const own: StoryParams = { settle: { timeout: 100, ready: true }, mask: ['.a'] };
    const e = explain(
      [story('a', own)],
      'a',
      { stories: { a: { settle: { timeout: 300 }, mask: ['.b'] } } },
      { live: own },
    );
    expect(src(e, 'settle.ready')).toEqual(['story']);
    expect(row(e, 'settle.timeout')?.value).toBe(300);
    expect(src(e, 'settle.timeout')).toEqual(['stories:a']);
    expect(row(e, 'mask')?.value).toEqual(['.a', '.b']);
    expect(src(e, 'mask')).toEqual(['story', 'stories:a']);
  });

  it('live repeating the story keeps the story as source under a variant', () => {
    const own: StoryParams = { settle: { timeout: 100 } };
    const e = explain(
      [story('a', { ...own, variants: { v: { settle: { ready: true } } } })],
      'a__v',
      {},
      { live: own },
    );
    expect(src(e, 'settle.timeout')).toEqual(['story']);
    expect(src(e, 'settle.ready')).toEqual(['variant:v (story parameters)']);
  });
});
