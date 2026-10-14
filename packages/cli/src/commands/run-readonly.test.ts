// `jux run` is read-only with respect to the committed manifest: only approve
// (or an explicit migration) writes it. A legacy project's first run used to
// fold structure into every passing entry and bump the version.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import type { Browser } from '@juxtapose/core';
import { captureIo } from '../io.js';

const image = Buffer.from('home-image');
const hash = createHash('sha256').update(image).digest('hex');

vi.mock('@juxtapose/core', async (orig) => ({
  ...(await orig<typeof import('@juxtapose/core')>()),
  runCapture: async (opts: {
    onArtifact: (a: Record<string, unknown>) => Promise<void>;
  }) => {
    await opts.onArtifact({
      storyId: 'home',
      status: 'pass',
      current: image,
      structure: {
        schema: 'juxtapose.structure/v1',
        viewport: { width: 1, height: 1 },
        structureHash: 'f'.repeat(64),
        contentHeight: 1,
        elements: [],
      },
    });
    return {
      runId: 'r',
      branch: 'b',
      commitSha: 'c',
      capturedCount: 1,
      totalCount: 1,
      results: [{ storyId: 'home', status: 'pass' }],
      summary: { pass: 1, fail: 0, new: 0, stale: 0, skip: 0 },
      durationMs: 1,
      startedAt: 't',
    };
  },
}));

const { runCommand } = await import('./run.js');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('a passing run on a legacy v1 project leaves the manifest byte-identical', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-run-ro-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'juxtapose.config.json'),
    JSON.stringify({
      platform: 'urls',
      urls: [{ id: 'home', url: 'http://127.0.0.1:1/' }],
    }),
  );
  const manifest =
    JSON.stringify(
      {
        version: 1,
        baselines: {
          home: {
            commit: 'x',
            approvedBy: 't',
            approvedAt: 't',
            hash,
            structureHash: 'f'.repeat(64),
          },
        },
      },
      null,
      2,
    ) + '\n';
  writeFileSync(path.join(root, 'juxtapose.manifest.json'), manifest);
  mkdirSync(path.join(root, '.juxtapose', 'baselines'), { recursive: true });

  const io = captureIo();
  const code = await runCommand(
    { project: root, all: true },
    {
      io,
      browser: () => Promise.resolve({ close: async () => {} } as unknown as Browser),
    },
  );
  expect(code, io.stderr()).toBe(0);
  expect(readFileSync(path.join(root, 'juxtapose.manifest.json'), 'utf8')).toBe(manifest);
  // The pass still fills the image cache; only the manifest is off limits.
  expect(
    existsSync(path.join(root, '.juxtapose', 'cache', 'baselines', `${hash}.webp`)),
  ).toBe(true);
});
