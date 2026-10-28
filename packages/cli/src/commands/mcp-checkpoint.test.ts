import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { encodeStoryId } from '@juxtapose/core';
import { McpServer } from './mcp.js';
import * as reference from './reference.js';
import * as runDir from '../run-dir.js';

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
  vi.restoreAllMocks();
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

const text = (result: Awaited<ReturnType<McpServer['call']>>) =>
  result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

test.each(['previous', 'r1'])(
  'run.compareTo %s matches a separate saved reference comparison',
  async (compareTo) => {
    const root = await fixture();
    await save(root, 'r1', black);
    runCommand.mockImplementation(async (_flags, session) => {
      session.io.out(JSON.stringify(await save(root, 'r2', whiteWebp)));
      return 1;
    });
    const server = new McpServer({ project: root, chrome: '/must-not-launch' });
    try {
      const result = await server.call('run', { compareTo });
      expect(result.isError).toBe(false);
      expect(
        JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')
          .runId,
      ).toBe('r2');
      expect(text(result)).toContain('juxtapose.design-reference-hint/v1');
      const separate = await server.call('reference', {
        compare: 'previous',
        fromRun: 'r1',
      });
      expect(text(result)).toContain(text(separate));
      expect(text(separate)).toContain('96 changed pixels');
      expect(runCommand).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  },
);

test('default runs do no checkpoint scan or comparison', async () => {
  const root = await fixture();
  const latest = vi.spyOn(runDir, 'latestRunDir');
  const compare = vi.spyOn(reference, 'evaluateReferenceChange');
  runCommand.mockImplementation(async (_flags, session) => {
    session.io.out(JSON.stringify(await save(root, 'r1', black)));
    return 1;
  });
  const server = new McpServer({ project: root, chrome: '/must-not-launch' });
  try {
    const result = await server.call('run', { feedback: 'none' });
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(latest).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

test('invalid and missing checkpoints fail before capture', async () => {
  const root = await fixture();
  const server = new McpServer({ project: root, chrome: '/must-not-launch' });
  try {
    for (const compareTo of ['', '../r1', '/r1', 1, null, 'absent', 'previous'])
      expect((await server.call('run', { compareTo })).isError).toBe(true);
    expect((await server.call('run', { compareTo: 'r1', dryRun: true })).isError).toBe(
      true,
    );
    expect(runCommand).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

test('checkpoint removal after capture preserves baseline and target evidence', async () => {
  const root = await fixture();
  await save(root, 'r1', black);
  runCommand.mockImplementation(async (_flags, session) => {
    const result = await save(root, 'r2', whiteWebp);
    await rm(path.join(root, '.juxtapose/runs/r1'), { recursive: true });
    session.io.out(JSON.stringify(result));
    return 1;
  });
  const server = new McpServer({ project: root, chrome: '/must-not-launch' });
  try {
    const result = await server.call('run', { compareTo: 'r1' });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain('juxtapose.agent-run/v1');
    expect(text(result)).toContain('juxtapose.design-reference-hint/v1');
    expect(text(result)).toContain('Saved checkpoint comparison unavailable:');
  } finally {
    await server.close();
  }
});

test('shared captures need no design references and large summaries remain bounded', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'juxtapose.config.json'), '{}');
  const before = await save(root, 'r1', black);
  // Many capture IDs share immutable test image bytes, exercising real decoding.
  const extend = async (id: string, report: typeof before) => {
    const dir = path.join(root, '.juxtapose/runs', id);
    report.results = Array.from({ length: 200 }, (_, i) => ({
      ...report.results[0]!,
      storyId: `card-${i}`,
    }));
    for (const result of report.results)
      await writeFile(
        path.join(dir, 'images', `${encodeStoryId(result.storyId)}-current.webp`),
        id === 'r1' ? black : whiteWebp,
      );
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(report));
    return report;
  };
  await extend('r1', before);
  runCommand.mockImplementation(async (_flags, session) => {
    session.io.out(JSON.stringify(await extend('r2', await save(root, 'r2', whiteWebp))));
    return 1;
  });
  const server = new McpServer({ project: root, chrome: '/must-not-launch' });
  try {
    const result = await server.call('run', { compareTo: 'previous', feedback: 'none' });
    expect(result.isError).toBe(false);
    const summary = result.content[1];
    expect(summary?.type).toBe('text');
    expect(text(result)).toContain('200 changed');
    expect(text(result)).toContain('192 more');
    expect(Buffer.byteLength(summary?.type === 'text' ? summary.text : '')).toBeLessThan(
      3000,
    );
    const separate = await server.call('reference', {
      compare: 'previous',
      fromRun: 'r1',
    });
    expect(text(result)).toContain(text(separate));
    const detail = await server.call('reference', {
      compare: 'previous',
      fromRun: 'r1',
      detail: 'json',
    });
    const states = JSON.parse(text(detail)).states;
    expect(states).toHaveLength(200);
    expect(
      states.every((state: { changedPixels: number }) => state.changedPixels === 96),
    ).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(1);
  } finally {
    await server.close();
  }
});
