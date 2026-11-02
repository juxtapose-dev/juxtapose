import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBaselineStore,
  type Platform,
  type ProjectConfig,
  type StoryManifest,
} from '@juxtapose/core';
import { RunDirSource } from './source.js';

const capture = vi.hoisted(() => vi.fn());
vi.mock('@juxtapose/core', async (original) => ({
  ...(await original<typeof import('@juxtapose/core')>()),
  acquireBrowser: async () => ({ isConnected: () => true }),
  runCapture: capture,
}));
const roots: string[] = [];
afterEach(async () => {
  capture.mockReset();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function source(enumerate: () => Promise<StoryManifest[]> = async () => []) {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-run-state-'));
  roots.push(root);
  return new RunDirSource({
    projectRoot: root,
    platform: { enumerate } as unknown as Platform,
    store: createBaselineStore(root, undefined),
    config: {} as ProjectConfig,
    baseUrl: 'http://localhost:1',
    runDir: path.join(root, 'run'),
    branch: 'main',
    commitSha: 'abc',
  });
}
const report = {
  runId: 'test',
  branch: 'main',
  commitSha: 'abc',
  results: [],
  summary: { pass: 0, fail: 0, new: 0, stale: 0, skip: 0 },
  durationMs: 0,
  startedAt: '2026-10-16T00:00:00Z',
  capturedCount: 0,
  totalCount: 0,
};

describe('review run lifecycle', () => {
  it('emits capture warnings without changing a completed review run', async () => {
    const src = await source();
    const warning = 'renderer-reused: a fresh renderer could not be obtained';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    capture.mockImplementationOnce(
      async (opts: Parameters<typeof import('@juxtapose/core').runCapture>[0]) => {
        opts.onWarning?.(warning);
        return report;
      },
    );
    await src.run();
    expect(stderr).toHaveBeenCalledWith(`juxtapose: ${warning}\n`);
    expect((await src.progress()).run?.status).toBe('completed');
    expect((await src.bundle()).report?.results).toEqual([]);
  });

  it('reserves discovery and honours cancellation before capture starts', async () => {
    let release!: (stories: StoryManifest[]) => void;
    const enumerate = vi.fn(
      () =>
        new Promise<StoryManifest[]>((resolve) => {
          release = resolve;
        }),
    );
    const src = await source(enumerate);
    const first = src.run();
    await src.run();
    expect(enumerate).toHaveBeenCalledTimes(1);
    expect((await src.progress()).run?.status).toBe('running');
    await src.cancel();
    release([]);
    await first;
    expect(capture).not.toHaveBeenCalled();
    expect((await src.bundle()).run?.status).toBe('cancelled');
    expect((await src.progress()).running).toBe(false);
  });

  it('retains a previous report while exposing failure, then clears the failure on retry', async () => {
    const src = await source();
    capture.mockResolvedValueOnce(report);
    await src.run();
    const previous = await src.bundle();
    capture.mockRejectedValueOnce(new Error('browser disconnected'));
    await expect(src.run()).rejects.toThrow('browser disconnected');
    const failed = await src.bundle();
    expect(failed.report).toEqual(previous.report);
    expect(failed.run).toMatchObject({ status: 'failed', error: 'browser disconnected' });
    expect(failed.run?.id).not.toBe(previous.run?.id);
    capture.mockResolvedValueOnce(report);
    await src.run();
    expect((await src.progress()).run).toMatchObject({ status: 'completed' });
    expect((await src.progress()).run?.error).toBeUndefined();
  });

  it('releases the reservation after discovery fails', async () => {
    const enumerate = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad index'))
      .mockResolvedValue([]);
    const src = await source(enumerate);
    await expect(src.run()).rejects.toThrow('bad index');
    expect((await src.progress()).running).toBe(false);
    expect((await src.progress()).run?.error).toBe('bad index');
    capture.mockResolvedValue(report);
    await src.run();
    expect(capture).toHaveBeenCalledOnce();
  });
});
