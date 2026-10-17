import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeStoryId } from '@juxtapose/core';
import { captureIo } from '../io.js';
import { evaluateReferences, referenceCommand } from './reference.js';
import { McpServer, withDesignReferenceFeedback } from './mcp.js';

const roots: string[] = [];
// Tiny solid-color fixtures keep this CLI test independent of sharp, which is
// an implementation dependency of core rather than the CLI package.
const white = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQYlWP4TyJgGNVABCA5lADspH6QblB3gwAAAABJRU5ErkJggg==',
  'base64',
);
const black = Buffer.from('UklGRhoAAABXRUJQVlA4TA4AAAAvC8ABAAcQEf0PRET/Aw==', 'base64');
const whiteWebp = Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvC8ABAAfQ//73v/+BiOh/AAA=',
  'base64',
);
const red = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DwnxTMMKqBgQahBAB3Fr9B2o/6XQAAAABJRU5ErkJggg==',
  'base64',
);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-reference-cli-'));
  roots.push(root);
  const runs = path.join(root, '.juxtapose/runs');
  const run = path.join(runs, 'r1');
  await mkdir(path.join(run, 'images'), { recursive: true });
  await mkdir(path.join(root, 'design'));
  await writeFile(path.join(root, 'design', 'target.png'), white);
  const desktop = 'card--default';
  const mobile = 'card--default__mobile';
  await writeFile(
    path.join(run, 'images', `${encodeStoryId(desktop)}-current.webp`),
    black,
  );
  await writeFile(
    path.join(run, 'images', `${encodeStoryId(mobile)}-current.webp`),
    whiteWebp,
  );
  await writeFile(
    path.join(run, 'report.json'),
    JSON.stringify({
      runId: 'r1',
      results: [
        { storyId: desktop, status: 'fail', viewport: { width: 12, height: 8 } },
        {
          storyId: mobile,
          baseStoryId: desktop,
          variant: 'mobile',
          status: 'pass',
          viewport: { width: 12, height: 8 },
        },
      ],
    }),
  );
  await writeFile(
    path.join(root, 'juxtapose.config.json'),
    JSON.stringify({
      designReferences: {
        desktop: {
          storyId: desktop,
          image: 'design/target.png',
          viewport: { width: 12, height: 8 },
        },
        mobile: {
          storyId: mobile,
          image: 'design/target.png',
          viewport: { width: 12, height: 8 },
        },
      },
    }),
  );
  return { root, run, runs, desktop, mobile };
}

test('all-state ledger compares exact capture keys from saved images without recapture', async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.run, 'report.json'), 'utf8');
  const result = await evaluateReferences({ project: f.root });
  expect(result.outcome).toBe('fail');
  expect(result.summary).toEqual({
    pass: 1,
    fail: 1,
    incompatible: 0,
    error: 0,
    notCaptured: 0,
  });
  expect(result.states.map((s) => [s.name, s.storyId, s.status])).toEqual([
    ['desktop', f.desktop, 'fail'],
    ['mobile', f.mobile, 'pass'],
  ]);
  expect(result.policy).toEqual({
    method: 'pixelmatch',
    threshold: 0.1,
    includeAA: false,
  });
  expect(await readFile(path.join(f.run, 'report.json'), 'utf8')).toBe(before);
  const io = captureIo();
  expect(await referenceCommand(undefined, { project: f.root }, { io })).toBe(1);
  expect(io.stdout()).toContain('1 pass, 1 fail');
  expect(io.stdout()).toContain('observed colors: target #ffffff, current #000000');
});

test('a run result gains bounded design feedback without changing its report block or recapturing', async () => {
  const f = await fixture();
  const original = JSON.stringify({ runId: 'r1', results: [{ storyId: f.desktop }] });
  const toolResult = {
    content: [{ type: 'text' as const, text: original }],
    isError: false,
  };
  const withReference = await withDesignReferenceFeedback(toolResult, f.root);
  expect(withReference.content[0]).toEqual({ type: 'text', text: original });
  expect(withReference.content).toHaveLength(2);
  const hint = JSON.parse((withReference.content[1] as { text: string }).text);
  expect(hint).toMatchObject({
    schema: 'juxtapose.design-reference-hint/v1',
    runId: 'r1',
    outcome: 'fail',
    counts: { pass: 1, fail: 1, notCaptured: 0 },
    states: [{ name: 'desktop', key: f.desktop, status: 'fail' }],
    omittedAffected: 0,
    passed: [{ name: 'mobile', key: f.mobile }],
    omittedPassed: 0,
  });
  expect(hint.states[0].largestRegion.id).toMatch(/^[a-f0-9]+:\d+$/);
});

test('a passing run lists the target keys without inviting a second reference call', async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.run, 'images', `${encodeStoryId(f.desktop)}-current.webp`),
    whiteWebp,
  );
  const run = {
    content: [{ type: 'text' as const, text: JSON.stringify({ runId: 'r1' }) }],
    isError: false,
  };
  const result = await withDesignReferenceFeedback(run, f.root);
  const hint = JSON.parse((result.content[1] as { text: string }).text);
  expect(hint).toMatchObject({
    outcome: 'pass',
    counts: { pass: 2, fail: 0 },
    states: [],
    passed: [
      { name: 'desktop', key: f.desktop },
      { name: 'mobile', key: f.mobile },
    ],
    omittedPassed: 0,
  });
  expect(hint.guidance).toContain('no reference call is needed');
});

test('empty and unrelated runs do not add design feedback', async () => {
  const f = await fixture();
  const empty = {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ runId: 'empty', capturedCount: 0 }),
      },
    ],
    isError: false,
  };
  expect(await withDesignReferenceFeedback(empty, f.root)).toBe(empty);
  expect(empty.content).toHaveLength(1);

  const unrelated = {
    content: [
      { type: 'text' as const, text: JSON.stringify({ runId: 'r1', capturedCount: 1 }) },
    ],
    isError: false,
  };
  await writeFile(
    path.join(f.run, 'report.json'),
    JSON.stringify({
      runId: 'r1',
      results: [
        {
          storyId: 'unrelated--story',
          status: 'pass',
          viewport: { width: 12, height: 8 },
        },
      ],
    }),
  );
  expect(await withDesignReferenceFeedback(unrelated, f.root)).toBe(unrelated);
  expect(unrelated.content).toHaveLength(1);
});

test('region IDs can recover a crop after reevaluation', async () => {
  const f = await fixture();
  const first = await evaluateReferences({ project: f.root, name: 'desktop' });
  const state = first.states[0]!;
  if (state.status === 'error') throw new Error(state.error);
  const regionId = state.regions[0]!.id;
  const again = await evaluateReferences({ project: f.root, name: 'desktop', regionId });
  expect(again.crop?.regionId).toBe(regionId);
  expect(again.crop?.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  await writeFile(path.join(f.root, 'design/target.png'), red);
  await expect(
    evaluateReferences({ project: f.root, name: 'desktop', regionId }),
  ).rejects.toThrow('Run reference again');
});

test('MCP returns the all-state ledger and one crop after a server restart without Chrome', async () => {
  const f = await fixture();
  const firstServer = new McpServer({ project: f.root, chrome: '/nonexistent/chrome' });
  const short = await firstServer.call('reference', {});
  expect(short.content[0]).toMatchObject({ type: 'text' });
  expect(short.content[0]!.type === 'text' ? short.content[0].text : '').toContain(
    '1 pass, 1 fail',
  );
  const first = await firstServer.call('reference', { detail: 'json' });
  expect(first.isError).toBe(false);
  const ledger = JSON.parse(
    first.content[0]!.type === 'text' ? first.content[0].text : '{}',
  );
  expect(ledger.summary).toEqual({
    pass: 1,
    fail: 1,
    incompatible: 0,
    error: 0,
    notCaptured: 0,
  });
  const id = ledger.states[0].regions[0].id as string;
  await firstServer.close();
  const secondServer = new McpServer({ project: f.root, chrome: '/nonexistent/chrome' });
  const crop = await secondServer.call('reference', { name: 'desktop', region: id });
  expect(crop.isError).toBe(false);
  expect(crop.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  await secondServer.close();
});

test('a subset run excludes unrelated and skipped references by default, but an explicit name errors', async () => {
  const f = await fixture();
  const configPath = path.join(f.root, 'juxtapose.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.designReferences.unrelated = {
    storyId: 'another--story',
    image: 'design/target.png',
    viewport: { width: 12, height: 8 },
  };
  await writeFile(configPath, JSON.stringify(config));
  const reportPath = path.join(f.run, 'report.json');
  await writeFile(
    reportPath,
    JSON.stringify({
      runId: 'r1',
      results: [
        { storyId: f.desktop, status: 'fail', viewport: { width: 12, height: 8 } },
        { storyId: f.mobile, status: 'skip' },
      ],
    }),
  );
  const result = await evaluateReferences({ project: f.root });
  expect(result.summary).toEqual({
    pass: 0,
    fail: 1,
    incompatible: 0,
    error: 0,
    notCaptured: 2,
  });
  expect(result.states.map((s) => s.name)).toEqual(['desktop']);
  const io = captureIo();
  expect(await referenceCommand(undefined, { project: f.root }, { io })).toBe(1);
  expect(io.stdout()).toContain('2 not captured');
  const explicit = await evaluateReferences({ project: f.root, name: 'unrelated' });
  expect(explicit.outcome).toBe('error');
  expect(explicit.summary).toEqual({
    pass: 0,
    fail: 0,
    incompatible: 0,
    error: 1,
    notCaptured: 0,
  });
  expect(explicit.states[0]).toMatchObject({
    status: 'error',
    error: 'capture key is absent from the saved run',
  });
});

test('a run with no configured capture is a no-comparison result, not a pass', async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.run, 'report.json'),
    JSON.stringify({
      runId: 'r1',
      results: [
        {
          storyId: 'unrelated--story',
          status: 'pass',
          viewport: { width: 12, height: 8 },
        },
      ],
    }),
  );
  const result = await evaluateReferences({ project: f.root });
  expect(result).toMatchObject({
    outcome: 'no-comparison',
    summary: { pass: 0, fail: 0, incompatible: 0, error: 0, notCaptured: 2 },
    states: [],
  });
  expect(result.message).toContain('Run the referenced story');
  const io = captureIo();
  expect(await referenceCommand(undefined, { project: f.root }, { io })).toBe(3);
  expect(io.stdout()).toContain('No configured design reference was captured');
  const server = new McpServer({ project: f.root, chrome: '/nonexistent/chrome' });
  const tool = await server.call('reference', {});
  expect(tool.isError).toBe(true);
  expect(tool.content[0]!.type === 'text' ? tool.content[0].text : '').toContain(
    'No configured design reference was captured',
  );
  await server.close();
});

test('geometry, missing captures, invalid config and path escapes are explicit', async () => {
  const f = await fixture();
  const configPath = path.join(f.root, 'juxtapose.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.designReferences.mobile.viewport.width = 11;
  await writeFile(configPath, JSON.stringify(config));
  const geometry = await evaluateReferences({ project: f.root, name: 'mobile' });
  expect(geometry.states[0]).toMatchObject({
    status: 'incompatible',
    reason: 'viewport',
  });
  config.designReferences.mobile.storyId = 'card--missing';
  await writeFile(configPath, JSON.stringify(config));
  const missing = await evaluateReferences({ project: f.root, name: 'mobile' });
  expect(missing.states[0]).toMatchObject({
    status: 'error',
    error: 'capture key is absent from the saved run',
  });
  config.designReferences.mobile.viewport.width = -1;
  await writeFile(configPath, JSON.stringify(config));
  await expect(evaluateReferences({ project: f.root })).rejects.toThrow();
  config.designReferences.mobile.viewport.width = 12;
  await writeFile(configPath, JSON.stringify(config));
  await expect(
    evaluateReferences({ project: f.root, run: path.dirname(f.root) }),
  ).rejects.toThrow('saved project run');
  const escape = path.join(f.runs, 'escape');
  await symlink(path.dirname(f.root), escape);
  await expect(evaluateReferences({ project: f.root, run: escape })).rejects.toThrow(
    'saved project run',
  );
  await rm(path.join(f.run, 'images', `${encodeStoryId(f.desktop)}-current.webp`));
  await symlink(
    configPath,
    path.join(f.run, 'images', `${encodeStoryId(f.desktop)}-current.webp`),
  );
  const confined = await evaluateReferences({ project: f.root, name: 'desktop' });
  expect(confined.states[0]).toMatchObject({
    status: 'error',
    error: 'saved image escapes the run',
  });
});
