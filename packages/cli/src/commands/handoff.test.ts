import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitBaselineStore, encodeStoryId } from '@juxtapose/core';
import { afterEach, expect, test } from 'vitest';
import { shellQuote } from '../shell-quote.js';
import { handoffCommand } from './handoff.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

test('handoff points at the store baseline and a quoted crops command', async () => {
  const STORY = 'Components/My Button--primary';
  const base = await mkdtemp(path.join(tmpdir(), 'jux-hand-'));
  dirs.push(base);
  const root = path.join(base, 'my proj');
  await mkdir(path.join(root, 'storybook-static'), { recursive: true });
  await writeFile(
    path.join(root, 'storybook-static/index.json'),
    JSON.stringify({ v: 5, entries: {} }),
  );
  const store = new GitBaselineStore({ projectRoot: root });
  await store.put(STORY, Buffer.from('baseline'), {
    commit: 'abc',
    approvedBy: 't',
    approvedAt: '2026-10-12T00:00:00Z',
  });
  const runDir = path.join(root, '.juxtapose/runs/r1');
  await mkdir(path.join(runDir, 'images'), { recursive: true });
  await writeFile(
    path.join(runDir, 'report.json'),
    JSON.stringify({
      runId: 'r1',
      results: [
        {
          storyId: STORY,
          status: 'fail',
          mismatchPercent: 1,
          mismatchPixels: 4,
          changedRegions: [],
        },
      ],
    }),
  );
  const current = path.join(runDir, 'images', `${encodeStoryId(STORY)}-current.webp`);
  await writeFile(current, 'current');

  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => (
    (out += s),
    true
  )) as typeof process.stdout.write;
  try {
    expect(await handoffCommand(STORY, { project: root })).toBe(0);
  } finally {
    process.stdout.write = write;
  }
  const baseline = store.locate(STORY);
  expect(existsSync(baseline)).toBe(true);
  expect(out).toContain(`- baseline: \`${baseline}\``);
  expect(out).toContain(
    `\`jux diff ${shellQuote(baseline)} ${shellQuote(current)} --crops --project ${shellQuote(root)}\``,
  );
  expect(out).toContain(`'${root}'`); // the space forced quoting
});
