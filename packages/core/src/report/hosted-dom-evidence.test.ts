import { expect, test } from 'vitest';
import { buildHostedDomEvidence } from './hosted-dom-evidence.js';
import { hashElements } from '../capture/structure.js';
import type { StructureElement, StructureSnapshot } from '../types.js';
const node = (extra: Partial<StructureElement> = {}): StructureElement => ({
  path: 'main',
  parent: null,
  tag: 'main',
  rect: { x: 0, y: 0, w: 100, h: 100 },
  paintOrder: 0,
  styles: {},
  ...extra,
});
function snapshot(elements: StructureElement[]): StructureSnapshot {
  return {
    schema: 'juxtapose.structure/v1',
    viewport: { width: 800, height: 600 },
    contentHeight: 600,
    elements,
    structureHash: hashElements(elements),
  };
}
test('exports genuine before/after tree matches and structural changes without changing original hashes', () => {
  const a = snapshot([
    node(),
    node({ parent: 0, tag: 'button', path: 'main>button', text: 'Save' }),
  ]);
  const b = snapshot([
    node(),
    node({ parent: 0, tag: 'button', path: 'main>button', text: 'Submit' }),
  ]);
  const evidence = buildHostedDomEvidence(a, b)!;
  expect(evidence.currentStructureHash).toBe(b.structureHash);
  expect(evidence.trees.matches).toEqual([
    { baselineIndex: 0, currentIndex: 0 },
    { baselineIndex: 1, currentIndex: 1 },
  ]);
  expect(
    evidence.changes.some(
      (c) => c.kind === 'text' && c.current?.index === 1 && c.baseline?.index === 1,
    ),
  ).toBe(true);
  expect(buildHostedDomEvidence(a, a)?.totalChanges).toBe(0);
});
test('strips control values, URL-bearing metadata and masked identities from trees and descriptions', () => {
  const a = snapshot([
    node(),
    node({
      parent: 0,
      path: 'input',
      tag: 'input',
      text: 'PRIVATE_VALUE',
      name: 'PRIVATE_VALUE',
    }),
    node({
      parent: 0,
      path: 'private#PRIVATE_MASK',
      tag: 'masked',
      id: 'PRIVATE_MASK',
      text: 'PRIVATE_MASK',
      styles: { color: 'red' },
    }),
    node({
      parent: 0,
      path: 'img',
      tag: 'img',
      src: 'https://example.test?token=PRIVATE_URL',
      styles: { 'background-image': 'url(https://example.test?token=PRIVATE_URL)' },
    }),
  ]);
  const evidence = buildHostedDomEvidence(a, a)!;
  expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_|https:/);
  expect(evidence.trees.current.nodes[2]).toMatchObject({
    selector: 'masked:nth-node(2)',
    attributes: {},
    styles: {},
  });
  const forged = snapshot([
    node(),
    node({ parent: 0, tag: 'INPUT', text: 'PRIVATE_VALUE' }),
  ]);
  expect(buildHostedDomEvidence(forged, forged)).toBeUndefined();
  const child = snapshot([
    node({ tag: 'masked' }),
    node({ parent: 0, text: 'PRIVATE_CHILD' }),
  ]);
  expect(buildHostedDomEvidence(child, child)).toBeUndefined();
});
test('enforces original hash, valid topology, node and UTF-8 byte budgets with honest truncation', () => {
  const a = snapshot(
    Array.from({ length: 160 }, (_, i) =>
      node({
        path: `div:nth-of-type(${i})`,
        parent: i ? 0 : null,
        text: '🦄'.repeat(250),
      }),
    ),
  );
  expect(
    buildHostedDomEvidence({ ...a, structureHash: '0'.repeat(64) }, a),
  ).toBeUndefined();
  const evidence = buildHostedDomEvidence(a, a, 12 * 1024)!;
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(12 * 1024);
  for (const tree of [evidence.trees.baseline, evidence.trees.current]) {
    expect(tree.nodes.length).toBeLessThanOrEqual(100);
    expect(tree.totalNodes).toBe(160);
    expect(tree.truncated).toBe(true);
    const seen = new Set<number>();
    for (const n of tree.nodes) {
      if (n.parentIndex !== null) expect(seen.has(n.parentIndex)).toBe(true);
      seen.add(n.index);
    }
  }
  expect(buildHostedDomEvidence(a, a, 100)).toBeUndefined();
});
