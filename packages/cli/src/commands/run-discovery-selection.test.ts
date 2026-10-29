// Exercise CLI selection with real git changes, graph validation and discovery
// cache plumbing; browser capture itself is replaced so these run without Chrome.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Browser, StoryManifest } from '@juxtapose/core';
import type { Context, CommonFlags } from '../context.js';
import { captureIo } from '../io.js';
let context: Context;
const captured: string[][] = [];
vi.mock('../context.js', async (orig) => ({
  ...(await orig<typeof import('../context.js')>()),
  resolveContext: async () => context,
}));
vi.mock('@juxtapose/core', async (orig) => ({
  ...(await orig<typeof import('@juxtapose/core')>()),
  runCapture: async (opts: { stories: StoryManifest[] }) => {
    captured.push(opts.stories.map((s) => s.storyId));
    return {
      runId: 'test',
      branch: 'main',
      commitSha: 'test',
      capturedCount: opts.stories.length,
      totalCount: opts.stories.length,
      results: opts.stories.map((s) => ({ storyId: s.storyId, status: 'pass' })),
      summary: { pass: opts.stories.length, fail: 0, new: 0, stale: 0, skip: 0 },
      durationMs: 1,
      startedAt: 'test',
    };
  },
}));
const { runCommand } = await import('./run.js');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  captured.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-discovery-cli-'));
  dirs.push(root);
  const build = path.join(root, 'build');
  mkdirSync(path.join(build, '.vite'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  writeFileSync(path.join(root, '.gitignore'), 'build/\n.juxtapose/\n');
  writeFileSync(path.join(root, 'a.ts'), 'export const a=1;\n');
  writeFileSync(path.join(root, 'a.stories.ts'), 'import {a} from "./a";\n');
  writeFileSync(path.join(root, 'b.stories.ts'), 'export const b=1;\n');
  git('init');
  git('add', '.gitignore', 'a.ts', 'a.stories.ts', 'b.stories.ts');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'fixture',
  );
  const modules = { 'a.ts': [], 'a.stories.ts': ['a.ts'], 'b.stories.ts': [] };
  const rebuild = () =>
    writeFileSync(
      path.join(build, '.vite/juxtapose-modules.json'),
      JSON.stringify({
        version: 3,
        root,
        builtAt: Date.now(),
        modules,
        hashes: Object.fromEntries(
          Object.keys(modules).map((f) => [
            f,
            createHash('sha256')
              .update(readFileSync(path.join(root, f)))
              .digest('hex'),
          ]),
        ),
        opaque: {},
        external: [],
        cssCodeSplit: true,
        workers: false,
      }),
    );
  rebuild();
  const stories = ['a', 'b'].map((id) => ({
    storyId: id,
    title: id,
    name: id,
    componentPath: path.join(root, `${id}.stories.ts`),
    params: {},
  }));
  const discover = vi.fn(
    async (_page: unknown, _url: string, ids?: readonly string[]) =>
      new Map((ids ?? ['a', 'b']).map((id) => [id, {}])),
  );
  const key = vi.fn(async (_target: unknown, ids?: readonly string[]) =>
    JSON.stringify(ids ?? null),
  );
  context = {
    projectRoot: root,
    buildDir: build,
    json: false,
    config: { variants: { dark: { colorScheme: 'dark' } } },
    platform: {
      name: 'fixture',
      configDirs: [],
      enumerate: async () => stories,
      discoverParams: discover,
      discoveryKey: key,
    } as unknown as Context['platform'],
    store: {} as Context['store'],
  };
  const browser = vi.fn(
    async () =>
      ({
        close: async () => {},
        newContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
      }) as unknown as Promise<Browser>,
  );
  const run = async (flags: CommonFlags) => {
    const io = captureIo();
    const code = await runCommand({ project: root, ...flags }, { io, browser });
    expect(code, io.stderr()).toBe(0);
    return io.stderr();
  };
  return { root, run, browser, discover, key, rebuild };
}
test.each([undefined, []])(
  '--all with project variants and story=%j uses whole-store discovery',
  async (story) => {
    const f = fixture();
    const output = await f.run({ all: true, ...(story ? { story } : {}) });
    expect(output).toContain('captures to take (all requested via --all)');
    expect(output).not.toContain('no-baseline');
    expect(f.discover.mock.calls[0]?.[2]).toBeUndefined();
    expect(f.key.mock.calls[0]?.[1]).toBeUndefined();
    expect(captured[0]).toEqual(['a', 'a__dark', 'b', 'b__dark']);
  },
);
test('--since narrows to changed component and retains its variants', async () => {
  const f = fixture();
  writeFileSync(path.join(f.root, 'a.ts'), 'export const a=2;\n');
  f.rebuild();
  const output = await f.run({ since: 'HEAD' });
  expect(output).toContain('graph-walk');
  expect(f.discover.mock.calls[0]?.[2]).toEqual(['a']);
  expect(captured[0]).toEqual(['a', 'a__dark']);
});
test.each(['stale', 'unmapped', 'config'] as const)(
  '--since %s fallback with variants reuses the full discovery key',
  async (kind) => {
    const f = fixture();
    await f.run({ all: true });
    if (kind === 'stale') writeFileSync(path.join(f.root, 'a.ts'), 'export const a=2;\n');
    if (kind === 'unmapped')
      writeFileSync(path.join(f.root, 'unknown.ts'), 'export const x=1;\n');
    if (kind === 'config')
      writeFileSync(path.join(f.root, 'juxtapose.config.json'), '{}');
    const output = await f.run({ since: 'HEAD' });
    expect(output).toContain(
      kind === 'stale'
        ? 'stale-graph'
        : kind === 'unmapped'
          ? 'unmapped-change'
          : 'config-changed',
    );
    expect(f.key.mock.calls.at(-1)?.[1]).toBeUndefined();
    expect(f.discover).toHaveBeenCalledTimes(1);
    expect(captured.at(-1)).toEqual(['a', 'a__dark', 'b', 'b__dark']);
  },
);
test('--since unchanged returns before browser launch or discovery', async () => {
  const f = fixture();
  const output = await f.run({ since: 'HEAD' });
  expect(output).toContain('no-changes');
  expect(f.browser).not.toHaveBeenCalled();
  expect(f.discover).not.toHaveBeenCalled();
  expect(captured).toEqual([]);
});
test('explicit variant selects its base for discovery before final selection', async () => {
  const f = fixture();
  await f.run({ story: ['a__dark'] });
  expect(f.discover.mock.calls[0]?.[2]).toEqual(['a']);
  expect(captured[0]).toEqual(['a__dark']);
});

test('glob narrows discovery and captures matching variants', async () => {
  const f = fixture();
  await f.run({ story: ['a*'] });
  expect(f.discover.mock.calls[0]?.[2]).toEqual(['a']);
  expect(captured[0]).toEqual(['a', 'a__dark']);
});
test.each([false, true])(
  'dry-run resolves variants without capturing, uploading, or writing a report (upload=%s)',
  async (upload) => {
    vi.stubEnv('JUXTAPOSE_TOKEN', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const f = fixture();
    context.json = true;
    const io = captureIo();
    expect(
      await runCommand(
        { project: f.root, story: ['*__dark'], 'dry-run': true, upload },
        { io, browser: f.browser },
      ),
    ).toBe(0);
    expect(JSON.parse(io.stdout())).toMatchObject({
      schema: 'juxtapose.selection/v1',
      count: 2,
      captures: [{ storyId: 'a__dark' }, { storyId: 'b__dark' }],
    });
    expect(captured).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const { readdirSync } = await import('node:fs');
    expect(
      readdirSync(path.join(f.root, '.juxtapose', 'runs')).filter(
        (name) => name !== '.cache',
      ),
    ).toEqual([]);
  },
);
test('an unmatched selector fails even if another selector matches', async () => {
  const f = fixture();
  const io = captureIo();
  expect(
    await runCommand(
      { project: f.root, story: ['a*', 'missing*'] },
      { io, browser: f.browser },
    ),
  ).toBe(2);
  expect(captured).toEqual([]);
  expect(io.stderr()).toContain('jux list');
});
