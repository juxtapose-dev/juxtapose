import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import type { Browser } from '@juxtapose/core';
import { captureIo } from '../io.js';

const { upload, capture } = vi.hoisted(() => ({ upload: vi.fn(), capture: vi.fn() }));
vi.mock('../hosted-upload.js', () => ({
  uploadConfig: () => ({ origin: 'https://api.example.com', token: 'test' }),
  uploadRun: upload,
  uploadMessage: () => 'uploaded\n',
}));
vi.mock('../context.js', async (orig) => ({
  ...(await orig<typeof import('../context.js')>()),
  gitSha: () => 'a'.repeat(40),
}));
vi.mock('@juxtapose/core', async (orig) => ({
  ...(await orig<typeof import('@juxtapose/core')>()),
  runCapture: capture,
}));
const { runCommand } = await import('./run.js');
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-review-run-'));
  dirs.push(root);
  await writeFile(
    path.join(root, 'juxtapose.config.json'),
    JSON.stringify({ platform: 'urls', urls: [{ id: 'A', url: 'http://127.0.0.1:1/' }] }),
  );
  const event = path.join(root, 'event.json');
  await writeFile(
    event,
    JSON.stringify({ number: 3, pull_request: { head: { sha: 'a'.repeat(40) } } }),
  );
  vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
  vi.stubEnv('GITHUB_EVENT_PATH', event);
  capture.mockResolvedValue({
    runId: 'r',
    branch: 'b',
    commitSha: 'a'.repeat(40),
    capturedCount: 1,
    totalCount: 1,
    results: [
      {
        storyId: 'A',
        status: 'new',
        hash: 'b'.repeat(64),
        mismatchPixels: 0,
        mismatchPercent: 0,
        durationMs: 1,
      },
    ],
    summary: { pass: 0, fail: 0, new: 1, stale: 0, skip: 0 },
    durationMs: 1,
    startedAt: new Date().toISOString(),
  });
  upload.mockResolvedValue({ runId: 'r', reportUrl: 'https://app.example.com/r' });
  const io = captureIo();
  const session = {
    io,
    browser: async () => ({ close: async () => {} }) as unknown as Browser,
  };
  return { root, session };
}
test('only successful hosted handoff exits clean for visual changes and forces full stability checks', async () => {
  const { root, session } = await setup();
  expect(
    await runCommand({ project: root, upload: true, 'review-in-github': true }, session),
  ).toBe(0);
  expect(upload).toHaveBeenCalledOnce();
  expect(capture.mock.calls[0]?.[0]).toMatchObject({ totalCount: 1, recheck: 'changed' });
  expect(session.io.stderr()).toContain('check owns visual approval');
});
test('ordinary --upload preserves review-required exit code', async () => {
  const { root, session } = await setup();
  expect(await runCommand({ project: root, all: true, upload: true }, session)).toBe(1);
});
test.each(['upload failure', 'unlinked project'])(
  'hosted mode does not swallow %s',
  async (reason) => {
    const { root, session } = await setup();
    if (reason === 'upload failure')
      upload.mockRejectedValue(new Error('network failed'));
    else upload.mockResolvedValue({ runId: 'r', reportUrl: null });
    await expect(
      runCommand({ project: root, upload: true, 'review-in-github': true }, session),
    ).rejects.toThrow();
  },
);
