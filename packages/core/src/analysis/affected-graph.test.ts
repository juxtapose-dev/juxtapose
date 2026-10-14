import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
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
    serializeModuleGraph(
      {
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
      },
      { root: proj },
    ),
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

  it('does not narrow a stylesheet edit, even one a component imports (N1-N3)', async () => {
    // Other plugins rewrite @import/@use/url() before any edge could be read, so
    // a stylesheet or asset change runs every story.
    for (const f of [
      'ui/legend.css',
      'ui/_partial.scss',
      'ui/logo.svg',
      'ui/data.json',
    ]) {
      const r = await run([f]);
      expect(r.reason).toBe('asset-changed');
      expect(r.detail).toBe(`${f} (stylesheets and assets aren't narrowed)`);
      expect(r.stories).toHaveLength(3);
    }
    // Beside a script edit too.
    expect((await run(['ui/Legend.tsx', 'ui/legend.css'])).reason).toBe('asset-changed');
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
    const r = await run(['src/preview.ts']);
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
        serializeModuleGraph(
          {
            'stories/A.stories.tsx': ['ui/A.tsx', '../shared/x.ts'],
            'stories/B.stories.tsx': ['ui/B.tsx'],
            'ui/A.tsx': [],
            'ui/B.tsx': [],
            '../shared/x.ts': [],
          },
          { root: web },
        ),
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

// The review round on #213: gaps a graph of JavaScript imports alone leaves.
describe('what the graph cannot prove', () => {
  let dir: string;
  const storiesIn = (d: string, ...names: string[]) =>
    names.map((n) => storyAt(`${n}--a`, path.join(d, `stories/${n}.stories.tsx`)));

  const write = async (
    modules: Record<string, string[]>,
    meta: Parameters<typeof serializeModuleGraph>[1],
    d = dir,
  ) => {
    await mkdir(path.join(d, 'sb', '.vite'), { recursive: true });
    await writeFile(
      path.join(d, 'sb', MODULE_GRAPH_FILE),
      serializeModuleGraph(modules, meta),
    );
  };

  const go = (
    d: string,
    s: StoryManifest[],
    files: string[],
    extra: { origin?: string } = {},
  ) =>
    resolveAffected(s, 'HEAD~1', {
      projectRoot: d,
      configDirs: ['.storybook'],
      buildDir: path.join(d, 'sb'),
      changedFiles: files,
      ...extra,
    });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jux-gaps-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a script edit still narrows when the build has stylesheets', async () => {
    await write(
      {
        'stories/A.stories.tsx': ['ui/A.tsx'],
        'stories/B.stories.tsx': ['ui/B.tsx'],
        'ui/A.tsx': ['ui/tokens.css'],
        'ui/B.tsx': [],
        'ui/tokens.css': [],
      },
      { root: dir },
    );
    const s = storiesIn(dir, 'A', 'B');
    expect(ids(await go(dir, s, ['ui/A.tsx']))).toEqual(['A--a']);
    expect((await go(dir, s, ['ui/tokens.css'])).reason).toBe('asset-changed');
  });

  it('a worker, worklet or computed asset path in the build stops all narrowing', async () => {
    await write(
      {
        'stories/A.stories.tsx': ['ui/A.tsx'],
        'stories/B.stories.tsx': [],
        'ui/A.tsx': [],
      },
      { root: dir, workers: true, opaque: { 'ui/A.tsx': 'web worker or worklet' } },
    );
    const s = storiesIn(dir, 'A', 'B');
    for (const f of ['ui/A.tsx', 'stories/B.stories.tsx']) {
      const r = await go(dir, s, [f]);
      expect(r.reason).toBe('unmapped-change');
      expect(r.detail).toContain('ui/A.tsx: web worker or worklet');
      expect(r.stories).toHaveLength(2);
    }
  });

  it('H2: a preview that every story imports (CSF factories) reaches every story', async () => {
    await write(
      {
        'stories/D.stories.tsx': ['.storybook/preview.tsx', 'ui/D.tsx'],
        'stories/E.stories.tsx': ['.storybook/preview.tsx'],
        '.storybook/preview.tsx': ['theme/global.ts', 'ui/Deco.tsx'],
        'theme/global.ts': [],
        'ui/Deco.tsx': [],
        'ui/D.tsx': [],
      },
      { root: dir },
    );
    const s = storiesIn(dir, 'D', 'E');
    for (const f of ['theme/global.ts', 'ui/Deco.tsx']) {
      const r = await go(dir, s, [f]);
      expect(r.reason).toBe('shared-entry-changed');
      expect(r.stories).toHaveLength(2);
    }
    // A component only story D imports still narrows.
    expect(ids(await go(dir, s, ['ui/D.tsx']))).toEqual(['D--a']);
  });

  it('M1: a docs page importing a component is a leaf, not a shared entry', async () => {
    await write(
      {
        'stories/A.stories.tsx': ['ui/A.tsx'],
        'stories/B.stories.tsx': [],
        'docs/A.mdx': ['ui/A.tsx'],
        'ui/A.tsx': [],
      },
      { root: dir },
    );
    const r = await go(dir, storiesIn(dir, 'A', 'B'), ['ui/A.tsx']);
    expect([r.reason, ids(r)]).toEqual(['graph-walk', ['A--a']]);
  });

  it('H3: --origin never uses the build’s graph', async () => {
    await write({ 'stories/A.stories.tsx': ['ui/A.tsx'], 'ui/A.tsx': [] }, { root: dir });
    const r = await go(dir, storiesIn(dir, 'A'), ['ui/A.tsx'], {
      origin: 'http://localhost:6006',
    });
    expect(r.reason).toBe('origin-run');
  });

  describe('H3/M1: staleness is content, not mtime', () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const graph = { 'stories/A.stories.tsx': ['ui/A.tsx'], 'ui/A.tsx': [] };
    let d: string;
    beforeAll(async () => {
      d = await mkdtemp(path.join(tmpdir(), 'jux-stale-'));
      await mkdir(path.join(d, 'ui'), { recursive: true });
      await writeFile(path.join(d, 'ui/A.tsx'), 'export const a = 1;');
    });
    afterAll(async () => {
      await rm(d, { recursive: true, force: true });
    });

    it('a fresh checkout after the build (new mtime, same content) is not stale', async () => {
      // Split CI: build in one job, check out again in another. Every mtime is
      // newer than the build, no byte is different.
      await write(
        graph,
        {
          root: d,
          builtAt: Date.now() - 3_600_000,
          hashes: { 'ui/A.tsx': sha('export const a = 1;') },
        },
        d,
      );
      const r = await go(d, storiesIn(d, 'A'), ['ui/A.tsx']);
      expect(r.reason).toBe('graph-walk');
    });

    it('changed content is stale even when the file looks older than the build', async () => {
      await write(
        graph,
        {
          root: d,
          builtAt: Date.now() + 3_600_000,
          hashes: { 'ui/A.tsx': sha('export const a = 0;') },
        },
        d,
      );
      const old = new Date(Date.now() - 86_400_000);
      await utimes(path.join(d, 'ui/A.tsx'), old, old);
      const r = await go(d, storiesIn(d, 'A'), ['ui/A.tsx']);
      expect(r.reason).toBe('stale-graph');
      expect(r.detail).toMatch(/ui\/A\.tsx.*rebuild the workbench/);
    });

    it('a recorded module that is gone counts as stale', async () => {
      await write(
        { ...graph, 'ui/Gone.tsx': [] },
        {
          root: d,
          hashes: { 'ui/A.tsx': sha('export const a = 1;'), 'ui/Gone.tsx': sha('x') },
        },
        d,
      );
      expect((await go(d, storiesIn(d, 'A'), ['ui/A.tsx'])).reason).toBe('stale-graph');
    });
  });

  it('P1: a markdown file in the source tree is not inert, nor one beside a glob-loaded one', async () => {
    // docs/*.md is loaded with import.meta.glob(…, { query: '?raw' }): a new
    // docs/b.md beside a script edit must not narrow to the script's stories.
    await write(
      {
        'stories/A.stories.tsx': ['ui/A.tsx'],
        'stories/M.stories.tsx': ['docs/a.md'],
        'ui/A.tsx': [],
        'docs/a.md': [],
      },
      { root: dir },
    );
    const s = storiesIn(dir, 'A', 'M');
    for (const files of [['docs/b.md'], ['ui/A.tsx', 'docs/b.md'], ['docs/a.md']]) {
      const r = await go(dir, s, files);
      expect(r.reason).toBe('asset-changed');
      expect(r.stories).toHaveLength(2);
    }
    // Even a root README is not inert once the graph loads markdown.
    expect((await go(dir, s, ['ui/A.tsx', 'README.md'])).reason).toBe('asset-changed');
  });

  it('P1: nothing under public/ is exempt', async () => {
    await write(
      {
        'stories/A.stories.tsx': ['ui/A.tsx'],
        'stories/B.stories.tsx': [],
        'ui/A.tsx': [],
      },
      { root: dir },
    );
    const s = storiesIn(dir, 'A', 'B');
    for (const f of ['public/help.md', 'public/robots.txt']) {
      const r = await go(dir, s, ['ui/A.tsx', f]);
      expect(r.reason).toBe('unmapped-change');
      expect(r.detail).toContain(f);
      expect(r.stories).toHaveLength(2);
    }
  });

  it('P1: root meta files and workflows beside a script edit still narrow', async () => {
    await write(
      {
        'stories/A.stories.tsx': ['ui/A.tsx'],
        'stories/B.stories.tsx': [],
        'ui/A.tsx': [],
      },
      { root: dir },
    );
    const s = storiesIn(dir, 'A', 'B');
    const r = await go(dir, s, [
      'ui/A.tsx',
      '.github/workflows/x.yml',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
    ]);
    expect([r.reason, ids(r)]).toEqual(['graph-walk', ['A--a']]);
  });

  it('P2: a file a build plugin read to make a virtual module escalates', async () => {
    await write(
      {
        'stories/A.stories.tsx': ['ui/A.tsx'],
        'stories/B.stories.tsx': [],
        'ui/A.tsx': [],
      },
      { root: dir, external: ['src/tokens.js'] },
    );
    const r = await go(dir, storiesIn(dir, 'A', 'B'), ['src/tokens.js']);
    expect(r.reason).toBe('unmapped-change');
    expect(r.detail).toBe('src/tokens.js is read by a build plugin, not imported');
    expect(r.stories).toHaveLength(2);
  });

  it('cssCodeSplit off: a .vue edit reaches every story', async () => {
    await write(
      {
        'stories/A.stories.vue': ['ui/A.vue'],
        'stories/B.stories.vue': [],
        'ui/A.vue': [],
      },
      { root: dir, cssCodeSplit: false },
    );
    const s = [
      storyAt('A--a', path.join(dir, 'stories/A.stories.vue')),
      storyAt('B--a', path.join(dir, 'stories/B.stories.vue')),
    ];
    const r = await go(dir, s, ['ui/A.vue']);
    expect(r.reason).toBe('asset-changed');
    expect(r.detail).toMatch(/cssCodeSplit off/);
    await write(
      {
        'stories/A.stories.vue': ['ui/A.vue'],
        'stories/B.stories.vue': [],
        'ui/A.vue': [],
      },
      { root: dir },
    );
    expect(ids(await go(dir, s, ['ui/A.vue']))).toEqual(['A--a']);
  });

  it('L2: a graph built relative to another root says so', async () => {
    await write(
      { 'stories/A.stories.tsx': ['ui/A.tsx'], 'ui/A.tsx': [] },
      { root: '/elsewhere' },
    );
    const r = await go(dir, storiesIn(dir, 'A'), ['ui/A.tsx']);
    expect(r.reason).toBe('graph-root-mismatch');
    expect(r.detail).toContain('/elsewhere');
    expect(r.detail).toContain(dir);
  });

  it('L4: a webpack build is not told to add a Vite plugin', async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'jux-webpack-'));
    try {
      await mkdir(path.join(d, 'sb'), { recursive: true });
      await writeFile(
        path.join(d, 'sb/project.json'),
        JSON.stringify({ builder: '@storybook/builder-webpack5' }),
      );
      const r = await go(d, storiesIn(d, 'A'), ['ui/A.tsx']);
      expect(r.reason).toBe('no-match-fallback');
      expect(r.detail).toMatch(/not available for @storybook\/builder-webpack5/);
      expect(r.detail).not.toMatch(/add the juxtapose Vite plugin/);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
