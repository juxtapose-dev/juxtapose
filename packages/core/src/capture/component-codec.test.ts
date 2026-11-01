import { describe, expect, it } from 'vitest';
import type { StructureSnapshot } from '../types.js';
import type { ComponentSnapshot } from '../components/evidence.js';
import {
  decodeStructure,
  encodeStructure,
  formatStructure,
  hashElements,
} from './structure.js';

const components: ComponentSnapshot = {
  schema: 'juxtapose.components/v1',
  trees: [
    {
      framework: 'vue',
      runtimeVersion: '3.5.40',
      parentRelation: 'rendered-parent',
      elementRelation: 'rendered-by',
      coverage: 'runtime',
      status: 'available',
      truncated: false,
      nodes: [{ id: 0, parent: null, name: 'Card', elements: [0] }],
    },
  ],
};
function structure(): StructureSnapshot {
  const elements = [
    {
      tag: 'main',
      path: 'html>body>main',
      parent: null,
      rect: { x: 0, y: 0, w: 100, h: 50 },
      paintOrder: 0,
      styles: {},
      text: 'Public text',
    },
  ];
  return {
    schema: 'juxtapose.structure/v1',
    structureHash: hashElements(elements),
    viewport: { width: 100, height: 100 },
    contentHeight: 100,
    elements,
  };
}

describe('optional component metadata sidecar boundary', () => {
  it('round-trips valid plain/readable/gzip metadata without affecting the structural hash', () => {
    const dom = structure();
    const withComponents = Object.assign(structure(), { components });
    for (const encoded of [
      Buffer.from(JSON.stringify(withComponents)),
      formatStructure(withComponents),
      encodeStructure(withComponents),
    ]) {
      const decoded = decodeStructure(encoded);
      expect(decoded).toEqual(withComponents);
      expect(decoded.structureHash).toBe(dom.structureHash);
      expect(hashElements(decoded.elements)).toBe(dom.structureHash);
    }
    expect(decodeStructure(encodeStructure(dom))).toEqual(dom);
  });

  it('drops only malformed components, preserving valid DOM and its exact original hash', () => {
    const dom = structure();
    for (const invalid of [
      null,
      { schema: 'untrusted' },
      {
        ...components,
        trees: [{ ...components.trees[0], status: 'unavailable', reason: 'masked' }],
      },
      {
        ...components,
        trees: [
          {
            ...components.trees[0],
            nodes: [{ id: 0, parent: null, name: 'Private', elements: [1] }],
          },
        ],
      },
    ]) {
      for (const encoded of [
        Buffer.from(JSON.stringify({ ...dom, components: invalid })),
        encodeStructure(Object.assign(structure(), { components: invalid })),
      ]) {
        expect(decodeStructure(encoded)).toEqual(dom);
      }
    }
  });

  it('copies sanitized component fields and never persists unknown application props or raw maps after decode', () => {
    const raw = structuredClone(components);
    Object.assign(raw.trees[0]!.nodes[0]!, {
      props: { password: 'SECRET' },
      state: 'SECRET',
    });
    Object.assign(raw, { sourceMap: 'SECRET' });
    const decoded = decodeStructure(
      Buffer.from(JSON.stringify({ ...structure(), components: raw })),
    );
    expect(decoded).toEqual({ ...structure(), components });
    expect(JSON.stringify(decoded)).not.toContain('SECRET');
  });
});
