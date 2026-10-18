import { afterEach, expect, test } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { encodeStoryId, encodeStructure, type StructureSnapshot } from '@juxtapose/core';
import { captureIo } from '../io.js';
import {
  evaluateReferenceChange,
  evaluateReferences,
  referenceCommand,
} from './reference.js';
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

test('a saved full-page capture compares against a target with separate layout viewport', async () => {
  const f = await fixture();
  const configPath = path.join(f.root, 'juxtapose.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.designReferences.mobile = {
    ...config.designReferences.mobile,
    viewport: { width: 12, height: 6 },
    captureKind: 'full-page',
  };
  await writeFile(configPath, JSON.stringify(config));
  const reportPath = path.join(f.run, 'report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.results[1].layoutViewport = { width: 12, height: 6 };
  await writeFile(reportPath, JSON.stringify(report));
  const result = await evaluateReferences({ project: f.root, name: 'mobile' });
  expect(result.outcome).toBe('pass');
  expect(result.states[0]).toMatchObject({
    status: 'pass',
    geometry: {
      captureKind: 'full-page',
      viewport: { width: 12, height: 6 },
      expectedPixels: { width: 12, height: 8 },
    },
  });
  delete report.results[1].layoutViewport;
  await writeFile(reportPath, JSON.stringify(report));
  const incompatible = await evaluateReferences({ project: f.root, name: 'mobile' });
  expect(incompatible.states[0]).toMatchObject({
    status: 'incompatible',
    reason: 'capture-kind',
  });
});

test('reference question leaves saved evidence and response unchanged', async () => {
  const f = await fixture();
  const server = new McpServer({ project: f.root, chrome: '/must-not-launch' });
  try {
    const args = { name: 'desktop', detail: 'layout' };
    const before = await server.call('reference', args);
    expect(before.isError).toBe(false);
    expect(
      await server.call('reference', {
        ...args,
        question: 'What target height is measurable for the control?',
      }),
    ).toEqual(before);
    for (const question of [' ', 'x'.repeat(161), false]) {
      const result = await server.call('reference', { ...args, question });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('question');
    }
  } finally {
    await server.close();
  }
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
  expect(hint.rgbaStates).toEqual({ equal: 1, different: 1, unverified: 0 });
  expect(hint.states[0].largestRegion.id).toMatch(/^[a-f0-9]+:\d+$/);
  expect(Object.keys(hint.states[0].largestRegion).sort()).toEqual(['id', 'pixels']);
  // The compact hint routes inspection; requested detail keeps the actual box.
  const detail = await evaluateReferences({ project: f.root });
  expect(detail.states[0]).toMatchObject({
    regions: [expect.objectContaining({ x: 0, y: 0, width: 12, height: 8 })],
  });
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
  expect(hint.policy).toEqual({ method: 'pixelmatch', threshold: 0.1, includeAA: false });
  expect(hint.guidance).toContain('NotCaptured is unverified');
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
  expect(again.crop?.box.width).toBeGreaterThan(0);
  expect(again.crop?.scale).toBeGreaterThan(0);
  // PNG IHDR dimensions verify the metadata against the actual encoded image.
  expect(again.crop?.width).toBe(again.crop!.png.readUInt32BE(16));
  expect(again.crop?.height).toBe(again.crop!.png.readUInt32BE(20));
  expect(again.crop?.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  await writeFile(path.join(f.root, 'design/target.png'), red);
  await expect(
    evaluateReferences({ project: f.root, name: 'desktop', regionId }),
  ).rejects.toThrow('Run reference again');
});

test('focused layout supplies usable saved-crop arguments without another ledger or browser', async () => {
  const f = await fixture();
  const reportBefore = await readFile(path.join(f.run, 'report.json'), 'utf8');
  const server = new McpServer({ project: f.root, chrome: '/nonexistent/chrome' });
  try {
    const focused = await server.call('reference', { name: 'desktop', detail: 'layout' });
    expect(focused.isError).toBe(false);
    const text = focused.content[0];
    if (text?.type !== 'text') throw new Error('expected focused text');
    const packet = JSON.parse(text.text);
    expect(packet.cropRequest).toEqual({
      name: 'desktop',
      region: expect.stringMatching(/^[a-f0-9]+:\d+$/),
    });
    const crop = await server.call('reference', packet.cropRequest);
    expect(crop.isError).toBe(false);
    expect(crop.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    // The matched agent used detail=crop with this valid region and was rejected.
    const explicitCrop = await server.call('reference', {
      ...packet.cropRequest,
      detail: 'crop',
    });
    expect(explicitCrop).toEqual(crop);
    const missingRegion = await server.call('reference', { detail: 'crop' });
    expect(missingRegion.isError).toBe(true);
    expect(missingRegion.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('requires a saved region ID'),
    });
    expect(await readFile(path.join(f.run, 'report.json'), 'utf8')).toBe(reportBefore);
  } finally {
    await server.close();
  }
});

test('MCP returns the all-state ledger and one crop after a server restart without Chrome', async () => {
  const f = await fixture();
  const firstServer = new McpServer({ project: f.root, chrome: '/nonexistent/chrome' });
  const short = await firstServer.call('reference', {});
  expect(short.content[0]).toMatchObject({ type: 'text' });
  expect(short.content[0]!.type === 'text' ? short.content[0].text : '').toContain(
    '1 pass, 1 fail',
  );
  expect(short.content[0]!.type === 'text' ? short.content[0].text : '').toContain(
    'Call reference with detail=json for measured geometry',
  );
  expect(short.content[0]!.type === 'text' ? short.content[0].text : '').not.toContain(
    'Use --json',
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
  expect(crop.content[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('Content outside this box is not shown'),
  });
  expect(crop.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  const detailed = await secondServer.call('reference', {
    name: 'desktop',
    region: id,
    detail: 'json',
  });
  const text = detailed.content[0];
  const metadata = JSON.parse(text?.type === 'text' ? text.text : '{}').crop;
  expect(metadata).toMatchObject({
    regionId: id,
    box: {
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    },
    scale: expect.any(Number),
    width: expect.any(Number),
    height: expect.any(Number),
  });
  expect(metadata.pngBase64).toBeUndefined();
  await secondServer.close();
});

test('MCP requests an edit-only image delta on demand from saved runs', async () => {
  const f = await fixture();
  const next = path.join(f.runs, 'r2');
  await mkdir(path.join(next, 'images'), { recursive: true });
  await writeFile(
    path.join(next, 'report.json'),
    JSON.stringify({
      runId: 'r2',
      results: [
        { storyId: f.desktop, status: 'pass', viewport: { width: 12, height: 8 } },
        { storyId: f.mobile, status: 'pass', viewport: { width: 12, height: 8 } },
      ],
    }),
  );
  await writeFile(
    path.join(next, 'images', `${encodeStoryId(f.desktop)}-current.webp`),
    whiteWebp,
  );
  await writeFile(
    path.join(next, 'images', `${encodeStoryId(f.mobile)}-current.webp`),
    whiteWebp,
  );
  await utimes(next, new Date('2030-01-01'), new Date('2030-01-01'));
  const change = await evaluateReferenceChange({ project: f.root, fromRun: 'r1' });
  expect(change).toMatchObject({
    fromRunId: 'r1',
    toRunId: 'r2',
    states: [
      {
        name: 'desktop',
        status: 'changed',
        changedPixels: 96,
        regions: [{ changedPixels: 96 }],
      },
      { name: 'mobile', status: 'unchanged', changedPixels: 0 },
    ],
  });
  const server = new McpServer({ project: f.root, chrome: '/nonexistent/chrome' });
  const target = await server.call('reference', {});
  expect(target.content[0]?.type === 'text' ? target.content[0].text : '').toContain(
    '2 pass',
  );
  const short = await server.call('reference', { compare: 'previous', fromRun: 'r1' });
  expect(short.isError).toBe(false);
  expect(short.content[0]?.type === 'text' ? short.content[0].text : '').toContain(
    '96 changed pixels',
  );
  const full = await server.call('reference', {
    compare: 'previous',
    fromRun: 'r1',
    detail: 'json',
  });
  const parsed = JSON.parse(
    full.content[0]?.type === 'text' ? full.content[0].text : '{}',
  );
  const id = parsed.states[0].regions[0].id as string;
  const crop = await server.call('reference', {
    compare: 'previous',
    fromRun: 'r1',
    name: 'desktop',
    region: id,
  });
  expect(crop.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  expect(
    await server.call('reference', {
      compare: 'previous',
      fromRun: 'r1',
      name: 'desktop',
      region: id,
      detail: 'crop',
    }),
  ).toEqual(crop);
  const cropDetail = await server.call('reference', {
    compare: 'previous',
    fromRun: 'r1',
    name: 'desktop',
    region: id,
    detail: 'json',
  });
  expect(cropDetail.isError).toBe(false);
  const cropText = cropDetail.content[0];
  const cropMetadata = JSON.parse(cropText?.type === 'text' ? cropText.text : '{}').crop;
  const cropImage = cropDetail.content[1];
  expect(cropImage?.type).toBe('image');
  if (cropImage?.type === 'image') {
    const bytes = Buffer.from(cropImage.data, 'base64');
    expect(cropMetadata.width).toBe(bytes.readUInt32BE(16));
    expect(cropMetadata.height).toBe(bytes.readUInt32BE(20));
  }
  expect(cropMetadata.box).toEqual(
    expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
  );
  expect(cropMetadata.scale).toBeGreaterThan(0);
  expect(crop.content[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('earlier left, later right'),
  });
  const currentImage = path.join(
    next,
    'images',
    `${encodeStoryId(f.desktop)}-current.webp`,
  );
  await writeFile(currentImage, black);
  const stale = await server.call('reference', {
    compare: 'previous',
    fromRun: 'r1',
    name: 'desktop',
    region: id,
  });
  expect(stale.isError).toBe(true);
  expect(stale.content[0]?.type === 'text' ? stale.content[0].text : '').toContain(
    'saved capture changed',
  );
  await writeFile(currentImage, whiteWebp);
  const configPath = path.join(f.root, 'juxtapose.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.designReferences.desktop.storyId = f.mobile;
  await writeFile(configPath, JSON.stringify(config));
  const remapped = await server.call('reference', {
    compare: 'previous',
    fromRun: 'r1',
    detail: 'json',
  });
  const remappedStates = JSON.parse(
    remapped.content[0]?.type === 'text' ? remapped.content[0].text : '{}',
  ).states;
  expect(remappedStates[0]).toMatchObject({
    name: 'desktop',
    storyId: f.mobile,
    status: 'unchanged',
  });
  await server.close();
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

function formStructure(gap: string): StructureSnapshot {
  return {
    schema: 'juxtapose.structure/v1',
    viewport: { width: 12, height: 8 },
    structureHash: gap,
    contentHeight: 8,
    elements: [
      {
        path: 'html>body>form',
        parent: null,
        tag: 'form',
        rect: { x: 0, y: 0, w: 12, h: 8 },
        paintOrder: 0,
        styles: { gap },
      },
    ],
  };
}

test('compare=previous checks any two saved runs as checkpoints, with structure and no design references', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-checkpoint-'));
  roots.push(root);
  await writeFile(path.join(root, 'juxtapose.config.json'), '{}');
  const story = 'form--default';
  const runs: Array<[string, Buffer, string, string]> = [
    ['r1', black, '12px', '2030-01-01'],
    ['r2', whiteWebp, '20px', '2030-01-02'],
    ['r3', whiteWebp, '20px', '2030-01-03'],
  ];
  for (const [runId, image, gap, date] of runs) {
    const dir = path.join(root, '.juxtapose/runs', runId);
    await mkdir(path.join(dir, 'images'), { recursive: true });
    await writeFile(
      path.join(dir, 'report.json'),
      JSON.stringify({
        runId,
        startedAt: `${date}T00:00:00Z`,
        capturedCount: 1,
        summary: { pass: 1, fail: 0, new: 0, stale: 0, skip: 0 },
        results: [{ storyId: story, status: 'pass', viewport: { width: 12, height: 8 } }],
      }),
    );
    await writeFile(
      path.join(dir, 'images', `${encodeStoryId(story)}-current.webp`),
      image,
    );
    await writeFile(
      path.join(dir, 'images', `${encodeStoryId(story)}-current.structure.json.gz`),
      encodeStructure(formStructure(gap)),
    );
    await utimes(path.join(dir, 'report.json'), new Date(date), new Date(date));
    await utimes(dir, new Date(date), new Date(date));
  }

  // r2 is not the latest run: the checkpoint and the attempt are both chosen.
  const change = await evaluateReferenceChange({
    project: root,
    fromRun: 'r1',
    toRun: 'r2',
  });
  expect(change).toMatchObject({
    fromRunId: 'r1',
    toRunId: 'r2',
    states: [
      {
        name: story,
        status: 'changed',
        structural: {
          deltas: [
            {
              kind: 'style',
              el: 'html>body>form',
              prop: 'gap',
              from: '12px',
              to: '20px',
            },
          ],
        },
      },
    ],
    changes: ['html>body>form gap 12px→20px (all 1)'],
  });
  // Identical saved bytes need no structural comparison.
  const same = await evaluateReferenceChange({ project: root, fromRun: 'r2' });
  expect(same.states[0]).toMatchObject({ status: 'unchanged', changedPixels: 0 });
  expect(same.states[0]).not.toHaveProperty('structural');
  expect(same).not.toHaveProperty('changes');

  const server = new McpServer({ project: root, chrome: '/nonexistent/chrome' });
  try {
    const text = await server.call('reference', {
      compare: 'previous',
      fromRun: 'r1',
      toRun: 'r2',
    });
    expect(text.isError).toBe(false);
    const body = text.content[0]?.type === 'text' ? text.content[0].text : '';
    expect(body).toContain('r1 → r2');
    expect(body).toContain('1 changed, 0 unchanged');
    expect(body).toContain('html>body>form gap 12px→20px (all 1)');
    const listed = await server.call('report', { detail: 'runs' });
    expect(
      JSON.parse(listed.content[0]?.type === 'text' ? listed.content[0].text : '{}'),
    ).toMatchObject({
      schema: 'juxtapose.saved-runs/v1',
      runs: [{ runId: 'r3' }, { runId: 'r2' }, { runId: 'r1' }],
      omitted: 0,
    });
    const misuse = await server.call('reference', { toRun: 'r2' });
    expect(misuse.isError).toBe(true);
  } finally {
    await server.close();
  }
});

// The deployment agent needed another mobile region, but requested full JSON
// still exposed only eight. Exercise real disconnected pixel differences and
// retrieval beyond that projection cutoff without opening a browser.
test('requested JSON exposes every computed region and a ninth crop for targets and checkpoints', async () => {
  const f = await fixture();
  const require = createRequire(import.meta.url);
  const sharp = createRequire(require.resolve('@juxtapose/core/package.json'))('sharp');
  const width = 400,
    height = 180;
  const svg = (rectangles: boolean) =>
    Buffer.from(
      `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${rectangles ? Array.from({ length: 12 }, (_, i) => `<rect x="${10 + (i % 6) * 60}" y="${10 + Math.floor(i / 6) * 80}" width="20" height="20" fill="black"/>`).join('') : ''}</svg>`,
    );
  const target = await sharp(svg(false)).png().toBuffer();
  const current = await sharp(svg(true)).webp({ lossless: true }).toBuffer();
  await writeFile(path.join(f.root, 'design/target.png'), target);
  await writeFile(
    path.join(f.run, 'images', `${encodeStoryId(f.desktop)}-current.webp`),
    current,
  );
  const report = {
    runId: 'r1',
    results: [{ storyId: f.desktop, status: 'fail', viewport: { width, height } }],
  };
  await writeFile(path.join(f.run, 'report.json'), JSON.stringify(report));
  await writeFile(
    path.join(f.root, 'juxtapose.config.json'),
    JSON.stringify({
      designReferences: {
        desktop: {
          storyId: f.desktop,
          image: 'design/target.png',
          viewport: { width, height },
        },
      },
    }),
  );
  const io = captureIo();
  expect(await referenceCommand('desktop', { project: f.root, json: true }, { io })).toBe(
    1,
  );
  const result = JSON.parse(io.stdout());
  expect(result.states[0].regions).toHaveLength(12);
  expect(result.states[0].regionCount).toBe(12);
  const ninth = result.states[0].regions[8].id;
  const server = new McpServer({ project: f.root, chrome: '/not-a-browser' });
  try {
    const crop = await server.call('reference', {
      name: 'desktop',
      region: ninth,
      detail: 'crop',
    });
    expect(crop.isError).toBe(false);
    expect(crop.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const before = path.join(f.runs, 'r0');
    await mkdir(path.join(before, 'images'), { recursive: true });
    await writeFile(
      path.join(before, 'images', `${encodeStoryId(f.desktop)}-current.webp`),
      await sharp(target).webp({ lossless: true }).toBuffer(),
    );
    await writeFile(
      path.join(before, 'report.json'),
      JSON.stringify({ ...report, runId: 'r0' }),
    );
    const checkpoint = await evaluateReferenceChange({
      project: f.root,
      fromRun: 'r0',
      toRun: 'r1',
      name: 'desktop',
    });
    expect(checkpoint.states[0]).toMatchObject({
      status: 'changed',
      regions: expect.any(Array),
    });
    const state = checkpoint.states[0] as { regions: Array<{ id: string }> };
    expect(state.regions).toHaveLength(12);
    const saved = await server.call('reference', {
      name: 'desktop',
      compare: 'previous',
      fromRun: 'r0',
      toRun: 'r1',
      region: state.regions[8]!.id,
      detail: 'crop',
    });
    expect(saved.isError).toBe(false);
    expect(saved.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  } finally {
    await server.close();
  }
});
