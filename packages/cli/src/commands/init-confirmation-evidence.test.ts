import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '',
  approved: [] as string[],
  failWrite: false,
  warning: '',
}));
vi.mock('../context.js', () => ({
  resolveContext: async () => ({
    projectRoot: state.root,
    origin: 'http://localhost',
    json: true,
    config: {},
    store: {},
    platform: {
      name: 'storybook',
      enumerate: async () => [{ storyId: 'spinner--small' }],
    },
  }),
  gitBranch: () => 'main',
  gitSha: () => 'sha',
  isGitRepo: () => false,
}));
vi.mock('../gitignore.js', () => ({
  ensureIgnored: async () => [],
  ignoredCommittedPaths: () => [],
}));
vi.mock('@juxtapose/core', async (original) => ({
  ...(await original<typeof import('@juxtapose/core')>()),
  resolveChrome: () => '/chrome',
  acquireBrowser: async () => ({ close: async () => {} }),
  prepareCaptures: async (stories: unknown) => stories,
  batchApprovals: async (_store: unknown, fn: (store: unknown) => Promise<void>) =>
    fn({}),
  approveCapture: async (_store: unknown, storyId: string) => {
    state.approved.push(storyId);
    return {};
  },
  runCapture: async (opts: {
    onArtifact: (a: unknown) => Promise<void>;
    onUnstableCapture?: (a: unknown) => Promise<void>;
    onWarning?: (message: string) => void;
  }) => {
    if (state.warning) opts.onWarning?.(state.warning);
    await opts.onArtifact({ storyId: 'spinner--small', current: Buffer.from('first') });
    if (state.failWrite) {
      const runs = path.join(state.root, '.juxtapose', 'runs');
      const run = (await readdir(runs)).find((x) => x !== '.cache')!;
      await mkdir(path.join(runs, run, 'images', 'spinner--small-confirmation.webp'));
    }
    await opts.onUnstableCapture?.({
      storyId: 'spinner--small',
      image: Buffer.from('second'),
      hash: 'b',
    });
    return {
      env: {},
      results: [
        { storyId: 'spinner--small', status: 'new', unstable: { hashes: ['a', 'b'] } },
      ],
    };
  },
}));
import { initCommand } from './init.js';

afterEach(async () => {
  if (state.root) await rm(state.root, { recursive: true, force: true });
  state.approved = [];
  state.failWrite = false;
  state.warning = '';
  vi.restoreAllMocks();
});
test('init emits capture warnings on stderr while keeping JSON stdout parseable', async () => {
  state.root = await mkdtemp(path.join(os.tmpdir(), 'jux-init-warning-'));
  state.warning = 'renderer-reused: a fresh renderer could not be obtained';
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await initCommand({ json: true })).toBe(1);
  expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
    `${state.warning}\n`,
  );
  expect(
    JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')),
  ).toMatchObject({
    unstable: ['spinner--small'],
  });
});

test('refused unstable init preserves both images and approves no baseline', async () => {
  state.root = await mkdtemp(path.join(os.tmpdir(), 'jux-init-confirm-'));
  expect(await initCommand({ json: true })).toBe(1);
  const runs = path.join(state.root, '.juxtapose', 'runs');
  const run = (await readdir(runs)).find((x) => x !== '.cache')!;
  const images = path.join(runs, run, 'images');
  expect(await readFile(path.join(images, 'spinner--small-current.webp'), 'utf8')).toBe(
    'first',
  );
  expect(
    await readFile(path.join(images, 'spinner--small-confirmation.webp'), 'utf8'),
  ).toBe('second');
  expect(state.approved).toEqual([]);
});

test('a confirmation write error stops init before any baseline approval', async () => {
  state.root = await mkdtemp(path.join(os.tmpdir(), 'jux-init-confirm-'));
  state.failWrite = true;
  await expect(initCommand({ json: true })).rejects.toThrow(
    /EISDIR|illegal operation on a directory/i,
  );
  expect(state.approved).toEqual([]);
});
