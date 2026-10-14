import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { RunDirSource, mergeReports, watchTargets } from './source.js';
import {
  encodeStoryId,
  encodeStructure,
  createBaselineStore,
  GitBaselineStore,
  VariantConfigError,
  type DiffResult,
  type Platform,
  type RunReport,
  type StructuralVerdict,
  type ProjectConfig,
  type StoryManifest,
  type StoryParams,
} from '@juxtapose/core';

const story = (storyId: string, params: StoryParams = {}): StoryManifest => ({
  storyId,
  title: storyId,
  name: storyId,
  componentPath: '/src/X.tsx',
  params,
});

describe('watchTargets', () => {
  it('recaptures every story sharing the edited component', () => {
    const ids = watchTargets('a', [story('a'), story('b'), story('c')]);
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips a sibling that opted out of live recapture', () => {
    // A long play function or a deliberate delay makes a keystroke-triggered
    // capture cost more than the feedback returns.
    const ids = watchTargets('a', [story('a'), story('b', { liveCapture: false })]);
    expect(ids).toEqual(['a']);
  });

  it('still captures an opted-out story when it is the one on screen', () => {
    // The opt-out is about collateral recapture, not about refusing to show
    // the developer what they are looking at.
    const ids = watchTargets('b', [story('a'), story('b', { liveCapture: false })]);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('includes the trigger even when the graph walk missed it', () => {
    // A story file the bundler manifest never recorded still has to recapture,
    // or watch mode does nothing for exactly the story being edited.
    expect(watchTargets('a', [])).toEqual(['a']);
  });

  it('does not duplicate the trigger', () => {
    expect(watchTargets('a', [story('a')])).toEqual(['a']);
  });
});

describe('RunDirSource.approve', () => {
  // The panel's approval path must keep the run's structure sidecar, as
  // `jux approve` does; before, it wrote the image only.
  it('writes the structure sidecar and its hash', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jux-src-'));
    const runDir = path.join(root, 'run');
    await mkdir(path.join(runDir, 'images'), { recursive: true });
    const safe = encodeStoryId('a--b');
    const gz = encodeStructure({
      schema: 'juxtapose.structure/v1',
      viewport: { width: 10, height: 10 },
      structureHash: 'e'.repeat(64),
      contentHeight: 10,
      elements: [],
    });
    await writeFile(path.join(runDir, 'images', `${safe}-current.webp`), 'img');
    await writeFile(path.join(runDir, 'images', `${safe}-current.structure.json.gz`), gz);
    const store = createBaselineStore(root, undefined);
    const source = new RunDirSource({
      projectRoot: root,
      platform: {} as Platform,
      store,
      config: {} as ProjectConfig,
      baseUrl: 'http://127.0.0.1:1',
      runDir,
      branch: 'main',
      commitSha: 'abc',
    });
    await source.approve('a--b');
    // The default store commits the sidecar as readable JSON, not gzip.
    expect(JSON.parse((await store.getStructure('a--b'))!.toString()).structureHash).toBe(
      'e'.repeat(64),
    );
    expect((await store.readManifest()).baselines['a--b'].structureHash).toBe(
      'e'.repeat(64),
    );
  });
});

describe('mergeReports', () => {
  const verdict = {
    signature: 's',
    change: 'c',
    summary: 'c',
    deltaCount: 1,
  } as StructuralVerdict;
  const fail = (storyId: string): DiffResult => ({
    storyId,
    status: 'fail',
    mismatchPixels: 1,
    mismatchPercent: 1,
    changedRegions: [],
    durationMs: 1,
    structural: verdict,
  });
  const report = (results: DiffResult[]): RunReport =>
    ({
      results,
      summary: { pass: 0, fail: 0, new: 0, stale: 0, skip: 0 },
      totalCount: results.length,
    }) as unknown as RunReport;

  it('regroups over the merged results, in code-unit order', () => {
    const merged = mergeReports(report([fail('a'), fail('Z')]), report([fail('b')]));
    expect(merged.results.map((r) => r.storyId)).toEqual(['Z', 'a', 'b']);
    expect(merged.groups?.map((g) => g.storyIds)).toEqual([['Z', 'a', 'b']]);
  });

  it('drops groups that no longer hold', () => {
    const stale = {
      ...report([fail('b')]),
      groups: [{ signature: 's', summary: 'x', storyIds: ['a', 'b'] }],
    };
    expect(mergeReports(report([]), stale).groups).toBeUndefined();
    const other = { ...fail('a'), structural: { ...verdict, signature: 'other' } };
    expect('groups' in mergeReports(report([other]), stale)).toBe(false);
  });
});

describe('RunDirSource with variants', () => {
  const enumerated = [
    { ...story('card--a'), title: 'Card', name: 'A', componentPath: '/src/Card.tsx' },
    { ...story('card--b'), componentPath: '/src/Card.tsx' },
    { ...story('other'), componentPath: '/src/Other.tsx' },
  ];
  const platform = {
    name: 'fake',
    enumerate: async () => enumerated,
  } as unknown as Platform;

  async function source(runDir = '/nonexistent') {
    const root = await mkdtemp(path.join(tmpdir(), 'jux-src-var-'));
    return new RunDirSource({
      projectRoot: root,
      platform,
      store: new GitBaselineStore({ projectRoot: root }),
      config: { variants: { dark: { colorScheme: 'dark' } } } as ProjectConfig,
      baseUrl: 'http://127.0.0.1:1',
      runDir,
      branch: 'main',
      commitSha: 'abc',
    });
  }

  it('stories() are captures: project variants expanded', async () => {
    const s = await source();
    expect((await s.stories()).map((x) => x.storyId)).toEqual([
      'card--a',
      'card--a__dark',
      'card--b',
      'card--b__dark',
      'other',
      'other__dark',
    ]);
  });

  it('affected(base id) expands to every capture sharing the component', async () => {
    const s = await source();
    expect((await s.affected('card--a')).sort()).toEqual([
      'card--a',
      'card--a__dark',
      'card--b',
      'card--b__dark',
    ]);
  });

  it("handoff on a variant uses the run's viewport, the story's source, and names the variant", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'jux-src-run-'));
    const result: DiffResult = {
      storyId: 'card--a__dark',
      baseStoryId: 'card--a',
      variant: 'dark',
      variantParams: { colorScheme: 'dark' },
      status: 'new',
      mismatchPixels: 0,
      mismatchPercent: 0,
      changedRegions: [],
      viewport: { width: 375, height: 812 },
      durationMs: 1,
    };
    await writeFile(
      path.join(runDir, 'report.json'),
      JSON.stringify({ runId: 'r', results: [result] }),
    );
    const text = await (await source(runDir)).handoff('card--a__dark');
    expect(text).toContain('# Visual change: Card — A');
    expect(text).toContain(
      'the `dark` variant of `card--a`, captured with colorScheme dark',
    );
    expect(text).toContain('/src/Card.tsx');
  });
});

describe('RunDirSource.handoff for a config skip (#128)', () => {
  it('names the stories entry that skipped it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jux-src-skip-'));
    const runDir = await mkdtemp(path.join(tmpdir(), 'jux-src-skip-run-'));
    const platform = {
      name: 'fake',
      enumerate: async () => [{ ...story('card--a'), componentPath: '/src/Card.tsx' }],
    } as unknown as Platform;
    const s = new RunDirSource({
      projectRoot: root,
      platform,
      store: new GitBaselineStore({ projectRoot: root }),
      config: { stories: { 'card--*': { skip: true } } } as ProjectConfig,
      baseUrl: 'http://127.0.0.1:1',
      runDir,
      branch: 'main',
      commitSha: 'abc',
    });
    await writeFile(
      path.join(runDir, 'report.json'),
      JSON.stringify({
        runId: 'r',
        results: [
          {
            storyId: 'card--a',
            status: 'skip',
            skippedBy: ['card--*'],
            mismatchPixels: 0,
            mismatchPercent: 0,
            changedRegions: [],
            durationMs: 0,
          },
        ],
      }),
    );
    const text = await s.handoff('card--a');
    expect(text).toContain('skipped by the project config');
    expect(text).toContain('`card--*`');
  });
});

describe('RunDirSource.handoff baseline (#115)', () => {
  // The prompt used to name `images/<id>-baseline.webp` in the run dir, which
  // nothing writes; an agent following it found no file.
  async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'jux-src-base-'));
    const runDir = path.join(root, 'run');
    await mkdir(runDir, { recursive: true });
    const results: DiffResult[] = [
      {
        storyId: 'a',
        status: 'fail',
        mismatchPixels: 1,
        mismatchPercent: 1,
        changedRegions: [],
        durationMs: 1,
      },
      {
        storyId: 'a__dark',
        baseStoryId: 'a',
        variant: 'dark',
        variantParams: { colorScheme: 'dark' },
        status: 'fail',
        mismatchPixels: 1,
        mismatchPercent: 1,
        changedRegions: [],
        durationMs: 1,
      },
    ];
    await writeFile(
      path.join(runDir, 'report.json'),
      JSON.stringify({ runId: 'r', results }),
    );
    const store = new GitBaselineStore({ projectRoot: root });
    const platform = {
      name: 'fake',
      enumerate: async () => [story('a')],
    } as unknown as Platform;
    const s = new RunDirSource({
      projectRoot: root,
      platform,
      store,
      config: {} as ProjectConfig,
      baseUrl: 'http://127.0.0.1:1',
      runDir,
      branch: 'main',
      commitSha: 'abc',
    });
    return { s, store };
  }

  const baselineLine = (text: string | null) =>
    /- baseline: `([^`]+)`/.exec(text ?? '')?.[1];

  it("points at the variant's own baseline in the store, and the file exists", async () => {
    const { s, store } = await setup();
    for (const id of ['a', 'a__dark']) {
      await mkdir(path.dirname(store.locate(id)), { recursive: true });
      await writeFile(store.locate(id), id);
    }
    const file = baselineLine(await s.handoff('a__dark'));
    expect(file).toBe(store.locate('a__dark'));
    expect(file).not.toBe(store.locate('a'));
    expect(existsSync(file ?? '')).toBe(true);
    expect(baselineLine(await s.handoff('a'))).toBe(store.locate('a'));
  });

  it('names no baseline when there is none yet', async () => {
    const { s } = await setup();
    const text = await s.handoff('a');
    expect(text).not.toBeNull();
    expect(baselineLine(text)).toBeUndefined();
    expect(text).not.toContain('-baseline.webp');
  });
});

describe('RunDirSource story loading', () => {
  const base = [story('a'), story('b')];

  async function make(platform: Platform, config: ProjectConfig = {}, runDir = '/none') {
    const root = await mkdtemp(path.join(tmpdir(), 'jux-src-load-'));
    return new RunDirSource({
      projectRoot: root,
      platform,
      store: new GitBaselineStore({ projectRoot: root }),
      config,
      baseUrl: 'http://127.0.0.1:1',
      runDir,
      branch: 'main',
      commitSha: 'abc',
    });
  }

  it('concurrent callers share one load', async () => {
    let calls = 0;
    const platform = {
      name: 'fake',
      enumerate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return base;
      },
    } as unknown as Platform;
    const s = await make(platform);
    const all = await Promise.all([s.stories(), s.stories(), s.affected('a')]);
    expect(all[0]).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it('a variant config error is kept until the stories or the config change', async () => {
    let calls = 0;
    const platform = {
      name: 'fake',
      enumerate: async () => {
        calls++;
        return base;
      },
    } as unknown as Platform;
    const s = await make(platform, { variants: { Dark: {} } } as ProjectConfig);
    await expect(s.stories()).rejects.toBeInstanceOf(VariantConfigError);
    await expect(s.stories()).rejects.toThrow(/variant name 'Dark'/);
    expect(calls).toBe(1);
    await s.flushIndex();
    await expect(s.stories()).rejects.toBeInstanceOf(VariantConfigError);
    expect(calls).toBe(2);
  });

  it('a bad project settle is a config error naming the project config', async () => {
    const platform = { name: 'fake', enumerate: async () => base } as unknown as Platform;
    for (const settle of [{ timeout: 0 }, { network: { ignore: ['type:Nope'] } }]) {
      const s = await make(platform, { settle } as ProjectConfig);
      await expect(s.stories()).rejects.toBeInstanceOf(VariantConfigError);
      await expect(s.stories()).rejects.toThrow(/^jux: project config: settle\./);
    }
  });

  it('a config file edit retries a cached config error', async () => {
    const platform = { name: 'fake', enumerate: async () => base } as unknown as Platform;
    const s = await make(platform, { variants: { Dark: {} } } as ProjectConfig);
    await expect(s.stories()).rejects.toBeInstanceOf(VariantConfigError);
    // The source keeps its config object; editing the file is what a user
    // does, and the stamp is what notices it.
    const root = (s as unknown as { opts: { projectRoot: string } }).opts.projectRoot;
    await writeFile(path.join(root, 'juxtapose.config.json'), '{}');
    const spy = vi.spyOn(
      s as unknown as { loadStories: () => Promise<unknown> },
      'loadStories',
    );
    await expect(s.stories()).rejects.toBeInstanceOf(VariantConfigError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('handoff reads the index, never discovery (no browser for a prompt)', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'jux-src-hand-'));
    await writeFile(
      path.join(runDir, 'report.json'),
      JSON.stringify({
        runId: 'r',
        results: [
          {
            storyId: 'a__dark',
            baseStoryId: 'a',
            variant: 'dark',
            variantParams: { colorScheme: 'dark' },
            status: 'new',
            mismatchPixels: 0,
            mismatchPercent: 0,
            changedRegions: [],
            durationMs: 1,
          },
        ],
      }),
    );
    const platform = {
      name: 'fake',
      enumerate: async () => base,
      discoverParams: async () => {
        throw new Error('discovery must not run for a handoff');
      },
    } as unknown as Platform;
    const s = await make(platform, {}, runDir);
    const browser = vi
      .spyOn(s as unknown as { ensureBrowser: () => Promise<unknown> }, 'ensureBrowser')
      .mockRejectedValue(new Error('no browser for a handoff'));
    const text = await s.handoff('a__dark');
    expect(text).toContain('the `dark` variant of `a`, captured with colorScheme dark');
    expect(browser).not.toHaveBeenCalled();
  });
});
