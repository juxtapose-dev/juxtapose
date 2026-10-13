import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCauseIndex, prepareCause } from './cause.js';
import { MAX_CAUSE_FILES } from '../diff/structural.js';
import { gitChangedFiles, type ViteManifest } from './affected.js';

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

// The project is the repository root here, so git's path and the
// project-relative path are the same string.
const same = (files: string[] | null) =>
  files && files.map((f) => ({ path: f, repoPath: f }));
const index = (changedFiles: string[] | null, m: ViteManifest | null = manifest) =>
  buildCauseIndex({
    projectRoot: root,
    configDirs: ['.storybook'],
    changedFiles: same(changedFiles),
    manifest: m,
  });
const button = () => path.join(root, 'src/Button.stories.tsx');
const card = () => path.join(root, 'src/Card.stories.tsx');

describe('buildCauseIndex', () => {
  it('finds a changed file in the closure with its graph distance', async () => {
    // Button's closure runs into `_chunk`: a hit, but not a full trace.
    expect(await index(['src/shared.ts']).causeFor(button())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/shared.ts', distance: 2 }],
      partial: true,
    });
  });

  // A hit is not the whole story unless the trace was complete: a changed
  // file the walk could not see (inlined, or behind a src-less chunk) may be
  // the real cause, and naming only the visible one read as a confident
  // answer on examples/storybook.
  it('a fully traced closure has no partial key; any untraced path marks it partial', async () => {
    const full = await index(['src/Card.tsx']).causeFor(card());
    expect(full).toEqual({ kind: 'in-closure', files: [{ path: 'src/Card.tsx', distance: 1 }] });
    expect('partial' in full).toBe(false);
    // A changed file no manifest entry names could be inlined anywhere.
    expect(await index(['src/Card.tsx', 'src/inlined.ts']).causeFor(card())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/Card.tsx', distance: 1 }],
      partial: true,
    });
    // A never-bundled file does not make it partial.
    expect('partial' in (await index(['src/Card.tsx', 'README.md']).causeFor(card()))).toBe(
      false,
    );
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
    // A nested package.json is not a dependency change. It is not a manifest
    // src either, and a JSON file can be imported, so it is unknown.
    expect((await index(['src/fixtures/package.json']).causeFor(card())).kind).toBe(
      'unknown',
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

  // An `imports[]` key with no manifest entry: the walk reaches a node it
  // cannot look inside, which is as untraced as a src-less chunk.
  it('a closure through a dangling import is unknown, never none-in-closure', async () => {
    const dangling: ViteManifest = {
      ...manifest,
      'src/Card.stories.tsx': {
        file: 'd.js',
        src: 'src/Card.stories.tsx',
        imports: ['_card', '_gone'],
      },
    };
    expect((await index(['README.md'], dangling).causeFor(card())).kind).toBe('unknown');
    expect(await index(['src/Card.tsx'], dangling).causeFor(card())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/Card.tsx', distance: 1 }],
      partial: true,
    });
  });

  // Ruling 8: the manifest is chunk-level. A module inlined into a chunk has
  // no entry, so a changed file the manifest never names could be inside any
  // chunk, this story's included. Fail safe: only a short allowlist of files
  // no bundler imports is exempt; anything else (JSON, SVG, ?raw assets,
  // .mdx) can be imported, so it blocks the claim.
  it('a changed file no manifest entry names is unknown unless it is never bundled', async () => {
    expect((await index(['src/inlined.ts']).causeFor(card())).kind).toBe('unknown');
    expect((await index(['src/theme.css']).causeFor(card())).kind).toBe('unknown');
    expect((await index(['src/data.json']).causeFor(card())).kind).toBe('unknown');
    expect((await index(['src/icon.svg']).causeFor(card())).kind).toBe('unknown');
    expect((await index(['docs/x.mdx']).causeFor(card())).kind).toBe('unknown');
    expect((await index(['src/query.graphql']).causeFor(card())).kind).toBe('unknown');
    // Files no bundler imports do not block the claim.
    for (const never of [
      'README.md',
      'docs/notes.md',
      'docs/guide.rst',
      'docs/a.adoc',
      'LICENSE',
      'CHANGELOG.md',
      'AUTHORS',
      'CODEOWNERS',
      '.gitignore',
      '.editorconfig',
      '.github/workflows/ci.yml',
    ])
      expect((await index([never]).causeFor(card())).kind, never).toBe('none-in-closure');
    // Named by the manifest but outside this closure: still honest.
    expect((await index(['src/Button.tsx']).causeFor(card())).kind).toBe(
      'none-in-closure',
    );
  });

  // Two entries can share a src (a module that is both an entry and a
  // dynamic import); the second must not erase the first's edges.
  it('merges the edges of manifest entries that share a src', async () => {
    const twice: ViteManifest = {
      ...manifest,
      _card2: { file: 'f.js', src: 'src/Card.stories.tsx', imports: ['_shared'] },
    };
    expect(await index(['src/Card.tsx'], twice).causeFor(card())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/Card.tsx', distance: 1 }],
    });
    expect(await index(['src/shared.ts'], twice).causeFor(card())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/shared.ts', distance: 1 }],
    });
  });

  // In a monorepo the root lockfile is `../../pnpm-lock.yaml` to the project
  // and `pnpm-lock.yaml` to git; only git's form says it is the root one.
  it('a monorepo-root lockfile, package.json or tsconfig is config', async () => {
    const nested = (repoPath: string) =>
      buildCauseIndex({
        projectRoot: root,
        configDirs: ['.storybook'],
        changedFiles: [{ path: `../../${repoPath}`, repoPath }],
        manifest,
      }).causeFor(card());
    expect(await nested('pnpm-lock.yaml')).toEqual({
      kind: 'config',
      files: [{ path: '../../pnpm-lock.yaml', distance: 0 }],
    });
    expect((await nested('package.json')).kind).toBe('config');
    expect((await nested('tsconfig.json')).kind).toBe('config');
    expect((await nested('tsconfig.base.json')).kind).toBe('config');
    // and at the project root itself
    expect((await index(['tsconfig.json']).causeFor(card())).kind).toBe('config');
    // a nested tsconfig (a fixture) is not one (and, unnamed, is unknown)
    expect((await index(['src/fixtures/tsconfig.json']).causeFor(card())).kind).toBe(
      'unknown',
    );
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
  // As prepareCause would hand them over: project-relative, plus git's
  // form relative to this repository's root.
  const realIndex = (changedFiles: string[]) =>
    buildCauseIndex({
      projectRoot: project(),
      configDirs: ['.storybook'],
      changedFiles: changedFiles.map((f) => ({
        path: f,
        repoPath: path.posix.normalize(`examples/storybook/${f}`),
      })),
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

  it('still finds the story file itself, as a partial trace', async () => {
    expect(await realIndex(['stories/Button.stories.jsx']).causeFor(story())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'stories/Button.stories.jsx', distance: 0 }],
      partial: true,
    });
  });

  // The real-workbench case: a token edit in the bundled component library
  // plus a label edit in the story. Only the story file is visible, so the
  // cause must say the rest could not be traced.
  it('a bundled edit beside a story edit is partial, not a confident story-file cause', async () => {
    expect(
      await realIndex(['../components/src/index.jsx', 'stories/Button.stories.jsx']).causeFor(
        story(),
      ),
    ).toEqual({
      kind: 'in-closure',
      files: [{ path: 'stories/Button.stories.jsx', distance: 0 }],
      partial: true,
    });
  });

  it('a .storybook change is config', async () => {
    expect((await realIndex(['.storybook/preview.js']).causeFor(story())).kind).toBe(
      'config',
    );
  });
});

// A real repository with the project in a subdirectory, like
// examples/storybook inside this repo: git says `app/src/Card.tsx`, the
// manifest says `src/Card.tsx`.
async function scratchRepo(m: ViteManifest, files: Record<string, string>) {
  const repo = await mkdtemp(path.join(tmpdir(), 'jux-cause-git-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const project = path.join(repo, 'app');
  const buildDir = path.join(project, 'build');
  await mkdir(path.join(buildDir, '.vite'), { recursive: true });
  await writeFile(path.join(buildDir, '.vite/manifest.json'), JSON.stringify(m));
  const write = async (rel: string, body: string) => {
    await mkdir(path.dirname(path.join(project, rel)), { recursive: true });
    await writeFile(path.join(project, rel), body);
  };
  for (const [rel, body] of Object.entries(files)) await write(rel, body);
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'one');
  const index = (sinceCommit: string) =>
    prepareCause({ projectRoot: project, buildDir, sinceCommit, configDirs: [] });
  return { repo, project, git, write, index };
}

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

  // git's own complaints ("fatal: not a git repository", diff's usage text)
  // went straight to the terminal through an inherited stderr. Checked in a
  // child process, since an inherited fd never passes through this one.
  it('says nothing on stderr outside a repository', async () => {
    const hooks = path.join(root, 'load-ts.mjs');
    await writeFile(
      hooks,
      `import { registerHooks } from 'node:module';
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (spec.startsWith('.') && spec.endsWith('.js')) return next(spec.slice(0, -3) + '.ts', ctx);
      throw e;
    }
  },
});
const { prepareCause } = await import(process.argv[2]);
const ix = prepareCause({ projectRoot: process.argv[3], sinceCommit: 'HEAD~1', configDirs: [] });
process.stdout.write(JSON.stringify(await ix.causeFor(process.argv[3] + '/x.ts')));
`,
    );
    const outside = await mkdtemp(path.join(tmpdir(), 'jux-cause-norepo-'));
    const r = spawnSync(
      process.execPath,
      [hooks, path.join(import.meta.dirname, 'cause.ts'), outside],
      { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } },
    );
    await rm(outside, { recursive: true, force: true });
    expect(r.stdout).toBe('{"kind":"unknown","files":[]}');
    expect(r.stderr).toBe('');
  });

  it('maps git top-level paths to the project root and traces the closure', async () => {
    const r = await scratchRepo(manifest, { 'src/Card.tsx': 'v1' });
    await r.write('src/Card.tsx', 'v2');
    r.git('commit', '-qam', 'two');
    expect(
      await r.index('HEAD~1').causeFor(path.join(r.project, 'src/Card.stories.tsx')),
    ).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/Card.tsx', distance: 1 }],
    });
    await rm(r.repo, { recursive: true, force: true });
  });

  // Ruling 9: the agent asks before committing, so an edit still in the
  // working tree (or a file not yet added) is a change.
  it('counts uncommitted edits and untracked files', async () => {
    const r = await scratchRepo(manifest, {
      'src/Card.stories.tsx': 'v1',
      'src/Button.stories.tsx': 'v1',
    });
    await r.write('src/Card.stories.tsx', 'v2');
    await r.write('src/shared.ts', 'new and untracked');
    const ix = r.index('HEAD');
    expect(await ix.causeFor(path.join(r.project, 'src/Card.stories.tsx'))).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/Card.stories.tsx', distance: 0 }],
    });
    expect(await ix.causeFor(path.join(r.project, 'src/Button.stories.tsx'))).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/shared.ts', distance: 2 }],
      partial: true,
    });
    await rm(r.repo, { recursive: true, force: true });
  });

  // Without -z, git quotes a non-ASCII or odd name (`"src/K\303\244rtchen..."`)
  // and the quoted string matches no manifest src.
  it('reads names with spaces and non-ASCII characters exactly', async () => {
    const story = 'src/Kärtchen Liste.stories.tsx';
    const comp = 'src/Kärtchen Liste.tsx';
    const m: ViteManifest = {
      [story]: { file: 'k.js', src: story, imports: ['_k'] },
      _k: { file: 'l.js', src: comp },
    };
    const r = await scratchRepo(m, { [comp]: 'v1' });
    await r.write(comp, 'v2');
    expect(await r.index('HEAD').causeFor(path.join(r.project, story))).toEqual({
      kind: 'in-closure',
      files: [{ path: comp, distance: 1 }],
    });
    await rm(r.repo, { recursive: true, force: true });
  });

  // Rename detection is a user setting (`diff.renames`); with it on, git
  // lists only the new name and the old story's change vanished.
  it('lists both sides of a rename whatever the git config', async () => {
    const r = await scratchRepo(manifest, { 'src/Card.stories.tsx': 'v1' });
    r.git('mv', 'app/src/Card.stories.tsx', 'app/src/Kard.stories.tsx');
    r.git('-c', 'diff.renames=true', 'commit', '-qm', 'rename');
    r.git('config', 'diff.renames', 'true');
    expect(gitChangedFiles('HEAD~1', r.project)?.sort()).toEqual([
      'app/src/Card.stories.tsx',
      'app/src/Kard.stories.tsx',
    ]);
    await rm(r.repo, { recursive: true, force: true });
  });
});
