import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAffected } from './affected.js';
import type { StoryManifest } from '../types.js';

let root: string;
let buildDir: string;

const story = (id: string, rel: string): StoryManifest => ({
  storyId: id,
  title: id,
  name: id,
  componentPath: path.join(root, rel),
  params: {},
});

let stories: StoryManifest[];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jux-affected-'));
  buildDir = path.join(root, 'build');
  await mkdir(path.join(buildDir, '.vite'), { recursive: true });

  // Button.tsx <- Button.stories.tsx ; Card.tsx <- Card.stories.tsx
  // shared.ts  <- Button.tsx (so a shared.ts change reaches Button only)
  await writeFile(
    path.join(buildDir, '.vite', 'manifest.json'),
    JSON.stringify({
      'src/Button.stories.tsx': {
        file: 'a.js',
        src: 'src/Button.stories.tsx',
        imports: ['_button'],
      },
      _button: { file: 'b.js', src: 'src/Button.tsx', imports: ['_shared'] },
      _shared: { file: 'c.js', src: 'src/shared.ts' },
      'src/Card.stories.tsx': {
        file: 'd.js',
        src: 'src/Card.stories.tsx',
        imports: ['_card'],
      },
      _card: { file: 'e.js', src: 'src/Card.tsx' },
    }),
  );

  stories = [
    story('button--primary', 'src/Button.stories.tsx'),
    story('card--default', 'src/Card.stories.tsx'),
  ];
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const opts = () => ({
  projectRoot: root,
  configDirs: ['.storybook'],
  buildDir,
});

describe('resolveAffected', () => {
  it('captures everything when there is no baseline commit', async () => {
    const r = await resolveAffected(stories, null, opts());
    expect(r.reason).toBe('no-baseline');
    expect(r.stories).toHaveLength(2);
  });

  it('captures nothing when nothing changed', async () => {
    const r = await resolveAffected(stories, 'HEAD~1', { ...opts(), changedFiles: [] });
    expect(r.reason).toBe('no-changes');
    expect(r.stories).toHaveLength(0);
  });

  it('walks the graph transitively to find affected stories', async () => {
    // shared.ts -> Button.tsx -> Button.stories.tsx. Card is untouched.
    const r = await resolveAffected(stories, 'HEAD~1', {
      ...opts(),
      changedFiles: ['src/shared.ts'],
    });
    expect(r.reason).toBe('graph-walk');
    expect(r.stories.map((s) => s.storyId)).toEqual(['button--primary']);
  });

  it('treats a changed story file as its own dependent', async () => {
    const r = await resolveAffected(stories, 'HEAD~1', {
      ...opts(),
      changedFiles: ['src/Card.stories.tsx'],
    });
    expect(r.stories.map((s) => s.storyId)).toEqual(['card--default']);
  });

  it('escalates to a full run when config changes', async () => {
    const r = await resolveAffected(stories, 'HEAD~1', {
      ...opts(),
      changedFiles: ['.storybook/preview.ts'],
    });
    expect(r.reason).toBe('config-changed');
    expect(r.stories).toHaveLength(2);
  });

  it('escalates to a full run when a lockfile changes', async () => {
    const r = await resolveAffected(stories, 'HEAD~1', {
      ...opts(),
      changedFiles: ['pnpm-lock.yaml'],
    });
    expect(r.reason).toBe('dependency-changed');
    expect(r.stories).toHaveLength(2);
  });

  it('escalates when files changed but nothing matched', async () => {
    // The safety net: a change outside the known graph must not read as
    // "nothing to do".
    const r = await resolveAffected(stories, 'HEAD~1', {
      ...opts(),
      changedFiles: ['public/logo.svg'],
    });
    expect(r.reason).toBe('no-match-fallback');
    expect(r.stories).toHaveLength(2);
  });

  it('escalates when no bundler manifest is available', async () => {
    const r = await resolveAffected(stories, 'HEAD~1', {
      projectRoot: root,
      configDirs: ['.storybook'],
      changedFiles: ['src/shared.ts'],
    });
    expect(r.reason).toBe('no-match-fallback');
    expect(r.stories).toHaveLength(2);
  });

  it('does not treat a nested package.json as a dependency change', async () => {
    // Only a root lockfile means "deps changed". A fixture named package.json
    // deep in the tree should go through the normal graph walk.
    const r = await resolveAffected(stories, 'HEAD~1', {
      ...opts(),
      changedFiles: ['src/fixtures/package.json'],
    });
    expect(r.reason).not.toBe('dependency-changed');
  });
});
