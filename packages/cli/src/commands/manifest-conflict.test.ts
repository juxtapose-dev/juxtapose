// A manifest with merge conflict markers is a lockfile to regenerate. approve
// and handoff surface that as one usage error (exit 2 via the entry point), not
// one failure per story or a silently missing baseline.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ManifestConflictError } from '@juxtapose/core';
import { afterEach, expect, test } from 'vitest';
import { captureIo } from '../io.js';
import { approveCommand } from './approve.js';
import { handoffCommand } from './handoff.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function conflictedProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-conflict-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'juxtapose.config.json'),
    JSON.stringify({
      platform: 'urls',
      urls: ['a', 'b', 'c'].map((id) => ({ id, url: `http://127.0.0.1:1/${id}` })),
    }),
  );
  writeFileSync(
    path.join(root, 'juxtapose.manifest.json'),
    '{\n<<<<<<< HEAD\n  "version": 1,\n=======\n  "version": 1,\n>>>>>>> m\n}\n',
  );
  const run = path.join(root, '.juxtapose', 'runs', 'r1');
  mkdirSync(path.join(run, 'images'), { recursive: true });
  const results = ['a', 'b', 'c'].map((storyId) => ({
    storyId,
    status: 'fail',
    mismatchPercent: 1,
    mismatchPixels: 1,
    changedRegions: [],
  }));
  writeFileSync(path.join(run, 'report.json'), JSON.stringify({ runId: 'r1', results }));
  for (const id of ['a', 'b', 'c'])
    writeFileSync(path.join(run, 'images', `${id}-current.webp`), `img-${id}`);
  return root;
}

test('approve --all with conflict markers throws the lockfile error once, not one failure per story', async () => {
  const root = conflictedProject();
  const io = captureIo();
  await expect(approveCommand({ project: root, all: true }, { io })).rejects.toThrow(
    ManifestConflictError,
  );
  expect(io.stderr()).not.toContain('could not write baseline');
});

test('handoff with conflict markers throws the lockfile error', async () => {
  const root = conflictedProject();
  const io = captureIo();
  await expect(handoffCommand('a', { project: root }, { io })).rejects.toThrow(
    /Don't hand-merge/,
  );
});
