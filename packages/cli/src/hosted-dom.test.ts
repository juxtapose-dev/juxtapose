import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
import { encodeStructure, encodeStoryId, type StructureSnapshot } from '@juxtapose/core';
import { hashElements } from '../../core/src/capture/structure.js';
import {
  attachHostedDom,
  readHostedStructure,
  HOSTED_REPORT_LIMIT,
} from './hosted-dom.js';
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
const imageHash = 'a'.repeat(64);
async function fixture(count = 1) {
  dir = await mkdtemp(path.join(tmpdir(), 'jux-dom-'));
  await mkdir(path.join(dir, 'images'));
  const elements = [
    {
      path: 'button',
      parent: null,
      tag: 'button',
      text: 'Save',
      rect: { x: 0, y: 0, w: 100, h: 30 },
      paintOrder: 0,
      styles: {},
    },
  ];
  const structure: StructureSnapshot = {
    schema: 'juxtapose.structure/v1',
    viewport: { width: 800, height: 600 },
    contentHeight: 600,
    elements,
    structureHash: hashElements(elements),
  };
  const results = Array.from({ length: count }, (_, i) => ({
    storyId: `button-${i}`,
    hash: imageHash,
    status: 'pass',
  }));
  for (const row of results)
    for (const role of ['baseline', 'current'])
      await writeFile(
        path.join(
          dir,
          'images',
          `${encodeStoryId(row.storyId)}-${role}.structure.json.gz`,
        ),
        encodeStructure({
          ...structure,
          captureIdentity: {
            storyId: row.storyId,
            imageHash,
            structureHash: structure.structureHash,
          },
        } as StructureSnapshot),
      );
  return {
    structure,
    results,
    snapshots: results.map((result) => ({
      result,
      contentHash: imageHash,
      baselineHash: imageHash,
    })),
  };
}
test('adds passing trees to the actual final report wrapper with image-bound sidecars', async () => {
  const f = await fixture();
  const input = {
    runId: 'run',
    sourceReport: { commitSha: 'c'.repeat(40), results: f.results },
  };
  const result = await attachHostedDom(input, dir, f.snapshots);
  expect(
    (result.sourceReport.results[0] as { domEvidence?: unknown }).domEvidence,
  ).toMatchObject({ schema: 'juxtapose.dom-evidence/v1', totalChanges: 0 });
  expect(input.sourceReport.results[0]).not.toHaveProperty('domEvidence');
  const file = path.join(
    dir,
    'images',
    `${encodeStoryId(f.results[0]!.storyId)}-current.structure.json.gz`,
  );
  expect(await readHostedStructure(file, 'other', imageHash)).toBeUndefined();
  expect(
    await readHostedStructure(file, f.results[0]!.storyId, 'b'.repeat(64)),
  ).toBeUndefined();
  await writeFile(file, encodeStructure(f.structure));
  expect(
    (await attachHostedDom(input, dir, f.snapshots)).sourceReport.results[0],
  ).not.toHaveProperty('domEvidence');
});
test('drops forged legacy metadata and corrupt or oversized compressed evidence without failing images', async () => {
  const f = await fixture();
  const file = path.join(
    dir,
    'images',
    `${encodeStoryId(f.results[0]!.storyId)}-current.structure.json.gz`,
  );
  for (const bytes of [
    Buffer.from('{broken'),
    Buffer.alloc(1024 * 1024 + 1),
    gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1)),
  ]) {
    await writeFile(file, bytes);
    const r = await attachHostedDom(
      {
        sourceReport: { results: [{ ...f.results[0]!, domEvidence: { forged: true } }] },
      },
      dir,
      f.snapshots,
    );
    expect(r.sourceReport.results[0]).not.toHaveProperty('domEvidence');
  }
  const r = await attachHostedDom(
    { sourceReport: { results: f.results } },
    dir,
    f.snapshots.map((s) => ({ ...s, baselineHash: undefined })),
  );
  expect(r.sourceReport.results[0]).not.toHaveProperty('domEvidence');
});
test('shares the whole-report UTF-8 budget and omits optional evidence when nearly full', async () => {
  const f = await fixture(4);
  const base = {
    padding: 'x'.repeat(HOSTED_REPORT_LIMIT - 16000),
    sourceReport: { results: f.results },
  };
  const result = await attachHostedDom(base, dir, f.snapshots);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    HOSTED_REPORT_LIMIT,
  );
  expect(result.sourceReport.results.every((r) => 'domEvidence' in r)).toBe(true);
  const tight = { ...base, padding: 'x'.repeat(HOSTED_REPORT_LIMIT - 700) };
  const small = await attachHostedDom(tight, dir, f.snapshots);
  expect(small.sourceReport.results.some((r) => 'domEvidence' in r)).toBe(false);
});
