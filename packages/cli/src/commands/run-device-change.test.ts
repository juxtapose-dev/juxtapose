// A story whose baseline was approved on another device is listed as such, the
// way an encoder change is, so nobody reads it as a regression.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Browser } from '@juxtapose/core';
import { captureIo } from '../io.js';

const fail = (storyId: string, extra: Record<string, unknown>) => ({
  storyId,
  status: 'fail',
  hash: 'h',
  mismatchPixels: 0,
  mismatchPercent: 0,
  changedRegions: [],
  ...extra,
});
const change = { from: 'default', to: 'portrait|m1t1|ua:ab' };

vi.mock('@juxtapose/core', async (orig) => ({
  ...(await orig<typeof import('@juxtapose/core')>()),
  runCapture: async () => ({
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
    capturedCount: 3,
    totalCount: 3,
    results: [
      fail('device', { baselineEmulation: change }),
      fail('both', { baselineEmulation: change, baselineEncoder: '8.17.3' }),
      fail('plain', {}),
    ],
    summary: { pass: 0, fail: 3, new: 0, stale: 0, skip: 0 },
    durationMs: 1,
    startedAt: 't',
  }),
}));

const { runCommand } = await import('./run.js');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('failing lines name a previous device emulation, alongside a previous encoder', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-run-device-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'juxtapose.config.json'),
    JSON.stringify({
      platform: 'urls',
      urls: [{ id: 'device', url: 'http://127.0.0.1:1/' }],
    }),
  );
  const io = captureIo();
  await runCommand(
    { project: root, all: true },
    {
      io,
      browser: () => Promise.resolve({ close: async () => {} } as unknown as Browser),
    },
  );
  const lines = io.stdout().split('\n');
  const line = (id: string) =>
    lines.find((l) => l.trim().startsWith(`fail`) && l.includes(id));
  expect(line('device')).toMatch(/ \(previous device emulation\)$/);
  expect(line('both')).toMatch(/ \(previous encoder\) \(previous device emulation\)$/);
  expect(line('plain')).not.toMatch(/previous/);
});
