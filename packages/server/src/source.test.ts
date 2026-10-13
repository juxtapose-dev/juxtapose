import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { RunDirSource, watchTargets } from './source.js';
import {
  encodeStoryId,
  encodeStructure,
  GitBaselineStore,
  type Platform,
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
    const store = new GitBaselineStore({ projectRoot: root });
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
    expect(await store.getStructure('a--b')).toEqual(gz);
    expect((await store.readManifest()).baselines['a--b'].structureHash).toBe(
      'e'.repeat(64),
    );
  });
});
