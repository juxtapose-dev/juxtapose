import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { encodeStoryId, encodeStructure } from '@juxtapose/core';
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

test.each(['valid', 'corrupt', 'error', 'mismatched'])(
  'hosted capture binds sidecars and tolerates optional baseline DOM: %s',
  async (mode) => {
    const { root, session } = await setup();
    const image = Buffer.from('capture-image'),
      hash = createHash('sha256').update(image).digest('hex');
    const structure = {
      schema: 'juxtapose.structure/v1' as const,
      viewport: { width: 800, height: 600 },
      contentHeight: 600,
      elements: [],
      structureHash: 'b'.repeat(64),
    };
    await writeFile(
      path.join(root, 'juxtapose.manifest.json'),
      JSON.stringify({
        version: 1,
        baselines: {
          A: {
            hash,
            structureHash:
              mode === 'mismatched' ? 'f'.repeat(64) : structure.structureHash,
            commit: 'a'.repeat(40),
            approvedBy: 'test',
            approvedAt: new Date().toISOString(),
          },
        },
      }),
    );
    const report = await capture();
    capture.mockImplementation(async (opts) => {
      opts.store.get = async () => image;
      opts.store.getStructure = async () => {
        if (mode === 'error') throw new Error('unavailable');
        return mode === 'corrupt' ? Buffer.from('{broken') : encodeStructure(structure);
      };
      await opts.onArtifact({ storyId: 'A', status: 'pass', current: image, structure });
      return report;
    });
    await expect(
      runCommand(
        { project: root, all: true, upload: true, 'review-in-github': true },
        session,
      ),
    ).resolves.toBe(0);
    const runDir = upload.mock.calls[0]![0] as string;
    const current = JSON.parse(
      gunzipSync(
        await readFile(
          path.join(runDir, 'images', `${encodeStoryId('A')}-current.structure.json.gz`),
        ),
      ).toString(),
    );
    expect(current.captureIdentity).toEqual({
      storyId: 'A',
      imageHash: hash,
      structureHash: structure.structureHash,
    });
    const baselineFile = path.join(
      runDir,
      'images',
      `${encodeStoryId('A')}-baseline.structure.json.gz`,
    );
    if (mode === 'valid')
      expect(
        JSON.parse(gunzipSync(await readFile(baselineFile)).toString()).captureIdentity,
      ).toEqual(current.captureIdentity);
    else await expect(readFile(baselineFile)).rejects.toThrow();
  },
);
