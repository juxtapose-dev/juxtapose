import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAffected, resolveAffectedFromPaths } from './affected.js';
import { MODULE_GRAPH_FILE, serializeModuleGraph } from './module-graph.js';
import type { StoryManifest } from '../types.js';

// A Storybook build bundles components into chunks that have no `src`: the
// manifest names the story files and nothing they import (#200). The graph the
// jux Vite plugin writes is what lets a component edit narrow the run.

let proj: string;
let build: string;
let set: StoryManifest[];

const storyAt = (id: string, abs: string): StoryManifest => ({
  storyId: id,
  title: id,
  name: id,
  componentPath: abs,
  params: {},
});

const run = (changedFiles: string[], buildDir = build) =>
  resolveAffected(set, 'HEAD~1', {
    projectRoot: proj,
    configDirs: ['.storybook'],
    buildDir,
    changedFiles,
  });

const ids = (r: { stories: StoryManifest[] }) => r.stories.map((s) => s.storyId).sort();

beforeAll(async () => {
  proj = await mkdtemp(path.join(tmpdir(), 'jux-graph-'));
  build = path.join(proj, 'storybook-static');
  await mkdir(path.join(build, '.vite'), { recursive: true });
  // Chunks with no src, as in the issue: only story files are named.
  await writeFile(
    path.join(build, '.vite', 'manifest.json'),
    JSON.stringify({
      'stories/Button.stories.tsx': {
        file: 'a.js',
        src: 'stories/Button.stories.tsx',
        imports: ['_c'],
      },
      'stories/Card.stories.tsx': {
        file: 'b.js',
        src: 'stories/Card.stories.tsx',
        imports: ['_c'],
      },
      'stories/Plain.stories.tsx': { file: 'c.js', src: 'stories/Plain.stories.tsx' },
      _c: { file: 'shared.js' },
    }),
  );
  await writeFile(
    path.join(build, MODULE_GRAPH_FILE),
    serializeModuleGraph({
      'stories/Button.stories.tsx': ['ui/Button.tsx'],
      'stories/Card.stories.tsx': ['ui/Card.tsx'],
      'stories/Plain.stories.tsx': [],
      'ui/Button.tsx': ['ui/tokens.ts'],
      'ui/Card.tsx': ['ui/Legend.tsx', 'ui/tokens.ts'],
      'ui/Legend.tsx': ['ui/legend.css'],
      'ui/legend.css': [],
      'ui/tokens.ts': [],
      // Imported by Storybook's virtual entry, which the plugin leaves out, so
      // no story reaches it: it runs for every story.
      'src/preview.ts': ['src/global.css'],
      'src/global.css': [],
    }),
  );
  set = [
    storyAt('button--a', path.join(proj, 'stories/Button.stories.tsx')),
    storyAt('card--a', path.join(proj, 'stories/Card.stories.tsx')),
    storyAt('plain--a', path.join(proj, 'stories/Plain.stories.tsx')),
  ];
});

afterAll(async () => {
  await rm(proj, { recursive: true, force: true });
});

describe('affected stories with the module graph the Vite plugin writes', () => {
  it('selects the stories that import an edited component', async () => {
    const r = await run(['ui/Legend.tsx']);
    expect(r.reason).toBe('graph-walk');
    expect(ids(r)).toEqual(['card--a']);
  });

  it('follows a stylesheet imported by a component', async () => {
    expect(ids(await run(['ui/legend.css']))).toEqual(['card--a']);
  });

  it('reaches every importer of a shared module, and no others', async () => {
    expect(ids(await run(['ui/tokens.ts']))).toEqual(['button--a', 'card--a']);
  });

  it("selects a changed story file's own stories", async () => {
    expect(ids(await run(['stories/Plain.stories.tsx']))).toEqual(['plain--a']);
  });

  it('unions several changed files', async () => {
    const r = await run(['ui/Button.tsx', 'stories/Plain.stories.tsx']);
    expect(ids(r)).toEqual(['button--a', 'plain--a']);
  });

  it('escalates when a module no story imports, such as the preview, changes', async () => {
    const r = await run(['src/global.css']);
    expect(r.reason).toBe('shared-entry-changed');
    expect(r.detail).toContain('src/preview.ts');
    expect(r.stories).toHaveLength(3);
  });

  it('escalates when any changed file is outside the graph, even beside a mapped one', async () => {
    // A narrowed run here would skip every story the logo can reach.
    for (const files of [['public/logo.svg'], ['ui/Legend.tsx', 'public/logo.svg']]) {
      const r = await run(files);
      expect(r.reason).toBe('unmapped-change');
      expect(r.detail).toContain('public/logo.svg');
      expect(r.stories).toHaveLength(3);
    }
  });

  it('does not escalate for files no bundler imports', async () => {
    const r = await run(['ui/Legend.tsx', 'README.md', '.github/workflows/ci.yml']);
    expect(r.reason).toBe('graph-walk');
    expect(ids(r)).toEqual(['card--a']);
  });

  it('always includes a story the graph does not contain', async () => {
    const r = await resolveAffected(
      [...set, storyAt('mdx--a', path.join(proj, 'stories/Elsewhere.stories.tsx'))],
      'HEAD~1',
      {
        projectRoot: proj,
        configDirs: ['.storybook'],
        buildDir: build,
        changedFiles: ['ui/Legend.tsx'],
      },
    );
    expect(ids(r)).toEqual(['card--a', 'mdx--a']);
  });

  it('still escalates on config, whatever the graph says', async () => {
    const r = await run(['ui/Legend.tsx', '.storybook/main.ts']);
    expect(r.reason).toBe('config-changed');
  });
});

describe('watch mode with the module graph', () => {
  it('widens a component edit to the stories that import it', async () => {
    const r = await resolveAffectedFromPaths(set, ['ui/Legend.tsx'], {
      projectRoot: proj,
      buildDir: build,
    });
    expect(ids({ stories: r })).toEqual(['card--a']);
  });
});

describe('without a module graph (a build made before the plugin was added)', () => {
  it('says how to get one when a component edit matches no manifest entry', async () => {
    // The chunk-only manifest of #200: the component is not named anywhere.
    await mkdir(path.join(proj, 'old', '.vite'), { recursive: true });
    await writeFile(
      path.join(proj, 'old', '.vite', 'manifest.json'),
      JSON.stringify({
        'stories/Card.stories.tsx': {
          file: 'b.js',
          src: 'stories/Card.stories.tsx',
          imports: ['_c'],
        },
        _c: { file: 'shared.js' },
      }),
    );
    const r = await run(['ui/Legend.tsx'], path.join(proj, 'old'));
    expect(r.reason).toBe('no-match-fallback');
    expect(r.stories).toHaveLength(3);
    expect(r.detail).toMatch(/module graph/);
  });

  it('does not narrow to a story edit when a component edit beside it is unnamed', async () => {
    // Narrowing to the story file would skip the stories the component reaches.
    await mkdir(path.join(proj, 'old2', '.vite'), { recursive: true });
    await writeFile(
      path.join(proj, 'old2', '.vite', 'manifest.json'),
      JSON.stringify({
        'stories/Plain.stories.tsx': { file: 'c.js', src: 'stories/Plain.stories.tsx' },
      }),
    );
    const r = await run(
      ['stories/Plain.stories.tsx', 'ui/Legend.tsx'],
      path.join(proj, 'old2'),
    );
    expect(r.stories).toHaveLength(3);
  });
});

describe('a project below the repository top (#96)', () => {
  it('maps git paths to project paths, including a sibling package', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'jux-graph-repo-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const web = path.join(repo, 'apps', 'web');
      const dist = path.join(web, 'storybook-static');
      await mkdir(path.join(dist, '.vite'), { recursive: true });
      await writeFile(
        path.join(dist, MODULE_GRAPH_FILE),
        serializeModuleGraph({
          'stories/A.stories.tsx': ['ui/A.tsx', '../shared/x.ts'],
          'stories/B.stories.tsx': ['ui/B.tsx'],
          'ui/A.tsx': [],
          'ui/B.tsx': [],
          '../shared/x.ts': [],
        }),
      );
      const s = [
        storyAt('a', path.join(web, 'stories/A.stories.tsx')),
        storyAt('b', path.join(web, 'stories/B.stories.tsx')),
      ];
      const go = (f: string) =>
        resolveAffected(s, 'HEAD~1', {
          projectRoot: web,
          configDirs: ['.storybook'],
          buildDir: dist,
          changedFiles: [f],
        });
      const inside = await go('apps/web/ui/A.tsx');
      expect([inside.reason, ids(inside)]).toEqual(['graph-walk', ['a']]);
      const beside = await go('apps/shared/x.ts');
      expect([beside.reason, ids(beside)]).toEqual(['graph-walk', ['a']]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
