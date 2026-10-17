import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { encodeStoryId } from '@juxtapose/core';
import { compactReferenceFeedback, McpServer } from './mcp.js';
import { evaluateReferences, type ReferenceResult } from './reference.js';
import { targetProgress } from './reference-progress.js';

const runCommand = vi.hoisted(() => vi.fn());
vi.mock('./run.js', () => ({ runCommand }));

const white = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQYlWP4TyJgGNVABCA5lADspH6QblB3gwAAAABJRU5ErkJggg==',
  'base64',
);
const black = Buffer.from('UklGRhoAAABXRUJQVlA4TA4AAAAvC8ABAAcQEf0PRET/Aw==', 'base64');
const whiteWebp = Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvC8ABAAfQ//73v/+BiOh/AAA=',
  'base64',
);
const roots: string[] = [];
afterEach(async () => {
  runCommand.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-one-call-'));
  roots.push(root);
  await writeFile(path.join(root, 'target.png'), white);
  await writeFile(
    path.join(root, 'juxtapose.config.json'),
    JSON.stringify({
      designReferences: {
        desktop: {
          storyId: 'card--default',
          image: 'target.png',
          viewport: { width: 12, height: 8 },
        },
      },
    }),
  );
  return root;
}

async function save(root: string, id: string, image: Buffer) {
  const dir = path.join(root, '.juxtapose/runs', id);
  await mkdir(path.join(dir, 'images'), { recursive: true });
  const report = {
    runId: id,
    capturedCount: 1,
    results: [
      {
        storyId: 'card--default',
        hash: createHash('sha256').update(image).digest('hex'),
        status: 'fail',
        viewport: { width: 12, height: 8 },
      },
    ],
  };
  await writeFile(
    path.join(dir, 'images', `${encodeStoryId('card--default')}-current.webp`),
    image,
  );
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report));
  const date = new Date(`2030-01-${id.slice(1).padStart(2, '0')}`);
  await utimes(path.join(dir, 'report.json'), date, date);
  await utimes(dir, date, date);
  return report;
}

test('one run resolves previous before capture and returns all three bounded blocks', async () => {
  const root = await fixture();
  await save(root, 'r1', black);
  runCommand.mockImplementation(async (_flags, session) => {
    const report = await save(root, 'r2', whiteWebp);
    session.io.out(JSON.stringify(report));
    return 1;
  });
  const server = new McpServer({ project: root, chrome: '/must-not-launch' });
  const result = await server.call('run', { compareTo: 'previous', progress: true });
  expect(result.isError).toBe(false);
  const texts = result.content.map((c) => (c.type === 'text' ? c.text : ''));
  expect(JSON.parse(texts[0]!)).toMatchObject({
    schema: 'juxtapose.agent-run/v1',
    runId: 'r2',
  });
  expect(JSON.parse(texts[1]!)).toMatchObject({
    outcome: 'pass',
    passed: [
      {
        name: 'desktop',
        bestRun: 'r2',
        progress: { fromRun: 'r1', pixels: [96, 0], trend: 'closer' },
      },
    ],
  });
  expect(texts[2]).toContain('juxtapose.saved-run-change/v1');
  expect(texts[2]).toContain('r1 → r2');
  expect(texts[2]).toContain('96 changed pixels');
  expect(runCommand).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(texts.join('\n'))).toBeLessThan(5000);
  // Subsequent detail reuses the same saved comparison, without capture.
  const detail = await server.call('reference', {
    compare: 'previous',
    fromRun: 'r1',
    toRun: 'r2',
    detail: 'json',
  });
  expect(detail.isError).toBe(false);
  expect(runCommand).toHaveBeenCalledTimes(1);
  await server.close();
});

test('invalid or missing checkpoints and incompatible options fail before capture', async () => {
  const root = await fixture();
  const server = new McpServer({ project: root, chrome: '/must-not-launch' });
  for (const args of [
    { compareTo: '../r1' },
    { compareTo: '' },
    { compareTo: 1 },
    { compareTo: 'previous' },
    { compareTo: 'absent' },
    { compareTo: 'r1', dryRun: true },
    { progress: true, dryRun: true },
    { progress: true, feedback: 'none' },
    { progress: 'yes' },
  ])
    expect((await server.call('run', args)).isError).toBe(true);
  expect(runCommand).not.toHaveBeenCalled();
  await server.close();
});

test('three saved runs identify regression from previous and retain the better checkpoint', async () => {
  const root = await fixture();
  await save(root, 'r1', black);
  await evaluateReferences({ project: root, run: 'r1' });
  await save(root, 'r2', whiteWebp); // no ledger: previous fallback must fill it
  await save(root, 'r3', black);
  const current = await evaluateReferences({ project: root, run: 'r3' });
  await targetProgress(root, current, 'r2');
  expect(current.states[0]).toMatchObject({
    bestRun: 'r2',
    progress: { fromRun: 'r2', pixels: [0, 96], trend: 'further' },
  });
  await save(root, 'r4', black);
  const same = await evaluateReferences({ project: root, run: 'r4' });
  await targetProgress(root, same, 'r3');
  expect(same.states[0]).toMatchObject({ bestRun: 'r2', progress: { trend: 'same' } });
});

test('a changed reference hash cannot reuse old bestRun or claim improvement', async () => {
  const root = await fixture();
  await save(root, 'r1', whiteWebp);
  await evaluateReferences({ project: root, run: 'r1' });
  // Different PNG bytes with the same decoded pixels still change target identity.
  await writeFile(
    path.join(root, 'target.png'),
    Buffer.concat([white, Buffer.from('new revision')]),
  );
  await save(root, 'r2', black);
  const current = await evaluateReferences({ project: root, run: 'r2' });
  // Only the immediate previous run may be recomputed. r1 is older here.
  await targetProgress(root, current);
  expect(current.states[0]).toMatchObject({ bestRun: 'r2' });
  expect(current.states[0]).not.toHaveProperty('progress');
});

test.each(['geometry', 'policy', 'capture-hash', 'checksum'])(
  'history abstains from stale %s evidence',
  async (field) => {
    const root = await fixture();
    await save(root, 'r1', whiteWebp);
    await evaluateReferences({ project: root, run: 'r1' });
    const dir = path.join(root, '.juxtapose/runs/r1/reference-analysis-v1');
    const file = path.join(dir, (await readdir(dir))[0]!);
    const entry = JSON.parse(await readFile(file, 'utf8'));
    if (field === 'geometry') entry.ledger.geometry.deviceScaleFactor = 2;
    if (field === 'policy') entry.ledger.policy.threshold = 0.2;
    if (field === 'capture-hash') entry.ledger.currentHash = '0'.repeat(64);
    entry.checksum =
      field === 'checksum'
        ? 'invalid'
        : createHash('sha256').update(JSON.stringify(entry.ledger)).digest('hex');
    await writeFile(file, JSON.stringify(entry));
    await save(root, 'r2', black);
    const current = await evaluateReferences({ project: root, run: 'r2' });
    await targetProgress(root, current);
    expect(current.states[0]).toMatchObject({ bestRun: 'r2' });
    expect(current.states[0]).not.toHaveProperty('progress');
  },
);

test('bestRun excludes saved analyses older than the newest 20 runs', async () => {
  const root = await fixture();
  await save(root, 'r1', whiteWebp);
  await evaluateReferences({ project: root, run: 'r1' });
  for (let i = 2; i <= 21; i++) await save(root, `r${i}`, black);
  const current = await evaluateReferences({ project: root, run: 'r21' });
  await targetProgress(root, current, 'r20');
  expect(current.states[0]).toMatchObject({
    bestRun: 'r21',
    progress: { trend: 'same' },
  });
});

test('300 target states stay bounded with progress and passing keys', () => {
  const state = {
    name: 'desktop',
    storyId: 'card--default',
    status: 'fail',
    mismatchPixels: 96,
    mismatchPercent: 100,
    regions: [],
    progress: { fromRun: 'r1', pixels: [100, 96], trend: 'closer' },
    bestRun: 'r2',
  };
  const result = {
    schema: 'juxtapose.design-reference-set/v1',
    runId: 'r2',
    outcome: 'fail',
    policy: { method: 'pixelmatch', threshold: 0.1, includeAA: false },
    summary: { pass: 150, fail: 150, incompatible: 0, error: 0, notCaptured: 1 },
    states: Array.from({ length: 300 }, (_, i) => ({
      ...state,
      name: `target-${i}`,
      storyId: `card--${i}`,
      status: i < 150 ? 'fail' : 'pass',
    })),
  } as ReferenceResult;
  const compact = compactReferenceFeedback(result);
  expect(compact.states).toHaveLength(8);
  expect(compact.passed).toHaveLength(8);
  expect(compact.omittedAffected).toBe(142);
  expect(compact.omittedPassed).toBe(142);
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(5000);
});
