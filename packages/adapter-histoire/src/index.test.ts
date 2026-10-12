// Enumeration and URL construction are the parts that can be wrong without
// the browser noticing — a bad id produces no ready message and no error, so
// a variant that never rendered looks like a slow one. Fixtures are shaped
// from real `histoire build` output (histoire@1.0.0-beta.1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoirePlatform } from './index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jux-histoire-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeIndex(stories: unknown[]): Promise<void> {
  await writeFile(
    path.join(dir, 'histoire.json'),
    JSON.stringify({ stories, markdownFiles: [] }),
  );
}

const target = () => ({ buildDir: dir, projectRoot: '/proj' });

describe('enumerate', () => {
  it('flattens variants into one manifest entry each', async () => {
    await writeIndex([
      {
        id: 'src-button-story-vue',
        title: 'Button',
        relativePath: 'src/Button.story.vue',
        treePath: ['Forms', 'Button'],
        variants: [
          { id: 'src-button-story-vue-0', title: 'Primary' },
          { id: 'src-button-story-vue-1', title: 'Ghost' },
        ],
      },
    ]);

    const stories = await new HistoirePlatform().enumerate(target());

    // One story file, two variants, two baselines.
    expect(stories).toHaveLength(2);
    expect(stories[0]).toMatchObject({
      storyId: 'src-button-story-vue-0',
      title: 'Forms/Button',
      name: 'Primary',
      componentPath: path.resolve('/proj', 'src/Button.story.vue'),
    });
  });

  it('skips docs-only stories and blanks the path for virtual ones', async () => {
    await writeIndex([
      {
        id: 'docs',
        title: 'Docs',
        docsOnly: true,
        variants: [{ id: 'docs-0', title: 'Page' }],
      },
      {
        id: 'virtual',
        title: 'Virtual',
        virtual: true,
        relativePath: 'generated.md',
        variants: [{ id: 'virtual-0', title: 'Gen' }],
      },
    ]);

    const stories = await new HistoirePlatform().enumerate(target());

    expect(stories.map((s) => s.storyId)).toEqual(['virtual-0']);
    // Blank rather than fabricated: affected-analysis reads it as
    // "can't prove unaffected" and captures.
    expect(stories[0].componentPath).toBe('');
  });

  it('reads namespaced params, variant overriding story', async () => {
    await writeIndex([
      {
        id: 's',
        title: 'S',
        meta: { juxtapose: { threshold: 0.5, skip: true } },
        variants: [
          { id: 's-0', title: 'Inherits' },
          { id: 's-1', title: 'Overrides', meta: { juxtapose: { skip: false } } },
        ],
      },
    ]);

    const stories = await new HistoirePlatform().enumerate(target());

    expect(stories[0].params).toEqual({ threshold: 0.5, skip: true });
    // Story-level threshold survives; only `skip` is overridden.
    expect(stories[1].params).toEqual({ threshold: 0.5, skip: false });
  });

  it('sorts by storyId, because a byte-exact hash makes order matter', async () => {
    await writeIndex([
      { id: 'b', title: 'B', variants: [{ id: 'b-0', title: 'B' }] },
      { id: 'a', title: 'A', variants: [{ id: 'a-0', title: 'A' }] },
    ]);

    const stories = await new HistoirePlatform().enumerate(target());
    expect(stories.map((s) => s.storyId)).toEqual(['a-0', 'b-0']);
  });
});

describe('storyUrl', () => {
  it('pairs each variant with its own story file id', async () => {
    await writeIndex([
      {
        id: 'src-button-story-vue',
        title: 'Button',
        // The two ids Histoire generates that a `-\d+$` strip gets wrong.
        variants: [
          { id: '_default', title: 'default' },
          { id: 'custom-id', title: 'Explicit' },
        ],
      },
    ]);

    const platform = new HistoirePlatform();
    await platform.enumerate(target());

    // Both must resolve to the owning story file, not to themselves.
    expect(platform.storyUrl('http://x/', '_default')).toBe(
      'http://x/__sandbox.html?storyId=src-button-story-vue&variantId=_default',
    );
    expect(platform.storyUrl('http://x', 'custom-id')).toBe(
      'http://x/__sandbox.html?storyId=src-button-story-vue&variantId=custom-id',
    );
  });
});

describe('configDirs', () => {
  it('names the root config file, which affected-analysis matches by exact path', () => {
    // Histoire's config is `histoire.config.ts` at the project root, not a
    // directory. Leaving it out means a config change would not force a full
    // run.
    const dirs = new HistoirePlatform().configDirs;
    expect(dirs).toContain('histoire.config.ts');
    expect(dirs).toContain('.histoire');
  });
});

describe('detect', () => {
  it('is false without an index rather than throwing', async () => {
    // A throwing detect would abort autodetection for every later platform.
    await expect(new HistoirePlatform().detect(target())).resolves.toBe(false);
  });

  it('is false when the dev server serves SPA HTML for histoire.json', async () => {
    // `histoire dev` answers /histoire.json with a 200 and the app shell, so
    // status alone is not evidence the platform is present.
    await writeFile(path.join(dir, 'histoire.json'), '<!DOCTYPE html><html></html>');
    await expect(new HistoirePlatform().detect(target())).resolves.toBe(false);
  });
});
