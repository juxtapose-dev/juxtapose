import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCauseIndex, prepareCause } from './cause.js';
import { MAX_CAUSE_FILES } from '../diff/structural.js';
import type { ViteManifest } from './affected.js';

// A minimal graph for the pure logic (Button.stories → Button → shared;
// Card.stories → Card; `_chunk` has no src, like a bundled chunk). The real
// shape — components in src-less chunks — is pinned separately below over a
// committed copy of the examples/storybook build's manifest.
const manifest: ViteManifest = {
  'src/Button.stories.tsx': {
    file: 'a.js',
    src: 'src/Button.stories.tsx',
    imports: ['_button'],
  },
  _button: { file: 'b.js', src: 'src/Button.tsx', imports: ['_shared', '_chunk'] },
  _shared: { file: 'c.js', src: 'src/shared.ts' },
  _chunk: { file: 'z.js' },
  'src/Card.stories.tsx': {
    file: 'd.js',
    src: 'src/Card.stories.tsx',
    imports: ['_card'],
  },
  _card: { file: 'e.js', src: 'src/Card.tsx' },
};

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jux-cause-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const index = (changedFiles: string[] | null, m: ViteManifest | null = manifest) =>
  buildCauseIndex({
    projectRoot: root,
    configDirs: ['.storybook'],
    changedFiles,
    manifest: m,
  });
const button = () => path.join(root, 'src/Button.stories.tsx');
const card = () => path.join(root, 'src/Card.stories.tsx');

describe('buildCauseIndex', () => {
  it('finds a changed file in the closure with its graph distance', async () => {
    expect(await index(['src/shared.ts']).causeFor(button())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/shared.ts', distance: 2 }],
    });
  });

  it('reports none-in-closure for a story the change cannot reach', async () => {
    expect(await index(['src/shared.ts']).causeFor(card())).toEqual({
      kind: 'none-in-closure',
      files: [],
    });
  });

  it('the story file itself is distance 0', async () => {
    const c = await index(['src/Button.stories.tsx']).causeFor(button());
    expect(c.files).toEqual([{ path: 'src/Button.stories.tsx', distance: 0 }]);
  });

  it('orders by distance, then path (code units), and caps at 5', async () => {
    const c = await index([
      'src/shared.ts',
      'src/Button.tsx',
      'src/Button.stories.tsx',
    ]).causeFor(button());
    expect(c.files.map((f) => f.distance)).toEqual([0, 1, 2]);
    const wide: ViteManifest = {
      'src/S.stories.tsx': {
        file: 's.js',
        src: 'src/S.stories.tsx',
        imports: Array.from({ length: 9 }, (_, k) => `_m${k}`),
      },
    };
    for (let k = 0; k < 9; k++)
      wide[`_m${k}`] = { file: `m${k}.js`, src: `src/m${k}.ts` };
    const changed = Array.from({ length: 9 }, (_, k) => `src/m${8 - k}.ts`);
    const many = await index(changed, wide).causeFor(
      path.join(root, 'src/S.stories.tsx'),
    );
    expect(many.files).toHaveLength(MAX_CAUSE_FILES);
    expect(many.files.map((f) => f.path)).toEqual([
      'src/m0.ts',
      'src/m1.ts',
      'src/m2.ts',
      'src/m3.ts',
      'src/m4.ts',
    ]);
  });

  it('a lockfile or config change is `config`, listing the file', async () => {
    expect(await index(['pnpm-lock.yaml', 'src/shared.ts']).causeFor(card())).toEqual({
      kind: 'config',
      files: [{ path: 'pnpm-lock.yaml', distance: 0 }],
    });
    expect((await index(['.storybook/preview.ts']).causeFor(card())).kind).toBe('config');
    // a nested package.json is not a dependency change
    expect((await index(['src/fixtures/package.json']).causeFor(card())).kind).toBe(
      'none-in-closure',
    );
  });

  // Review Focus 1
  it('a story the manifest does not know is unknown, never none-in-closure', async () => {
    expect((await index(['src/shared.ts']).causeFor('')).kind).toBe('unknown');
    expect(
      (
        await index(['src/shared.ts']).causeFor(
          path.join(root, 'src/Elsewhere.stories.tsx'),
        )
      ).kind,
    ).toBe('unknown');
  });

  it('no manifest or no git answer is unknown', async () => {
    expect((await index(['src/shared.ts'], null).causeFor(button())).kind).toBe(
      'unknown',
    );
    expect((await index(null).causeFor(button())).kind).toBe('unknown');
  });

  // Review Focus 1 (and refinement 9): a src-less chunk means the closure
  // was not fully traced. A hit in the traced part is still a hit; no hit
  // is unknown, never "not your code".
  it('a closure through a chunk without src is unknown unless a changed file was found', async () => {
    expect((await index(['README.md']).causeFor(button())).kind).toBe('unknown');
    expect((await index(['src/shared.ts']).causeFor(button())).kind).toBe('in-closure');
    // Card's closure has no chunk: fully traced, so none-in-closure is honest.
    expect((await index(['README.md']).causeFor(card())).kind).toBe('none-in-closure');
  });

  it('an empty change set on a fully traced closure is none-in-closure', async () => {
    expect((await index([]).causeFor(card())).kind).toBe('none-in-closure');
  });
});

// The real thing: examples/storybook's Vite manifest, copied by
// scripts/capture-cause-manifest.mjs. Stories have a src; the component
// library (examples/components/src/index.jsx) is bundled into `_index-*.js`
// chunks that do not.
describe('the real Storybook manifest', () => {
  const real = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, '__fixtures__/storybook-manifest.json'),
      'utf8',
    ),
  ) as ViteManifest;
  const project = () => path.join(root, 'examples/storybook');
  const story = () => path.join(project(), 'stories/Button.stories.jsx');
  const realIndex = (changedFiles: string[]) =>
    buildCauseIndex({
      projectRoot: project(),
      configDirs: ['.storybook'],
      changedFiles,
      manifest: real,
    });

  it('has src-less chunks (or this test is pinning the wrong shape)', () => {
    expect(Object.values(real).some((e) => !e.src)).toBe(true);
    expect(real['stories/Button.stories.jsx']?.src).toBe('stories/Button.stories.jsx');
  });

  it('never says none-in-closure for a component edit', async () => {
    // Project-relative, as prepareCause maps git's `examples/components/src/index.jsx`.
    const c = await realIndex(['../components/src/index.jsx']).causeFor(story());
    expect(c.kind).toBe('unknown');
  });

  it('never says none-in-closure for an unrelated file either, since the closure is not fully traced', async () => {
    expect((await realIndex(['../../README.md']).causeFor(story())).kind).toBe('unknown');
  });

  it('still finds the story file itself', async () => {
    expect(await realIndex(['stories/Button.stories.jsx']).causeFor(story())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'stories/Button.stories.jsx', distance: 0 }],
    });
  });

  it('a .storybook change is config', async () => {
    expect((await realIndex(['.storybook/preview.js']).causeFor(story())).kind).toBe(
      'config',
    );
  });
});

describe('prepareCause', () => {
  it('reads the manifest and git only on the first causeFor, and never throws', async () => {
    // No build dir, and a directory that is not a git repo: both reads fail
    // and the answer is unknown, with no exception reaching the caller.
    const ix = prepareCause({
      projectRoot: root,
      sinceCommit: 'HEAD~1',
      configDirs: ['.storybook'],
    });
    expect(await ix.causeFor(button())).toEqual({ kind: 'unknown', files: [] });
  });

  it('maps git top-level paths to the project root and traces the closure', async () => {
    // A real repository with the project in a subdirectory, like
    // examples/storybook inside this repo: git says `app/src/Card.tsx`, the
    // manifest says `src/Card.tsx`.
    const repo = await mkdtemp(path.join(tmpdir(), 'jux-cause-git-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    const project = path.join(repo, 'app');
    const buildDir = path.join(project, 'build');
    await mkdir(path.join(buildDir, '.vite'), { recursive: true });
    await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(buildDir, '.vite/manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(project, 'src/Card.tsx'), 'v1');
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
    await writeFile(path.join(project, 'src/Card.tsx'), 'v2');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two');
    const ix = prepareCause({
      projectRoot: project,
      buildDir,
      sinceCommit: 'HEAD~1',
      configDirs: [],
    });
    expect(await ix.causeFor(path.join(project, 'src/Card.stories.tsx'))).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/Card.tsx', distance: 1 }],
    });
    await rm(repo, { recursive: true, force: true });
  });
});
