import { describe, expect, it } from 'vitest';
import { parseComponentSnapshot } from './evidence.js';

const fixture = () => ({
  schema: 'juxtapose.components/v1',
  trees: [
    {
      framework: 'react',
      runtimeVersion: '18.3.1',
      parentRelation: 'rendered-parent',
      elementRelation: 'rendered-by',
      coverage: 'runtime',
      status: 'available',
      truncated: false,
      nodes: [
        { id: 0, parent: null, name: 'App', elements: [0] },
        { id: 1, parent: 0, name: 'Row', elements: [1] },
        { id: 2, parent: 0, name: 'Row', elements: [] },
      ],
    },
  ],
});

describe('component evidence boundary', () => {
  it('preserves distinct instances and strips unrequested application data', () => {
    const value = fixture();
    Object.assign(value.trees[0]!.nodes[1]!, {
      props: { password: 'SECRET' },
      state: 'SECRET',
    });
    const parsed = parseComponentSnapshot(value, 2);
    expect(parsed?.trees[0]?.nodes).toHaveLength(3);
    expect(parsed?.trees[0]?.nodes[2]).toEqual({
      id: 2,
      parent: 0,
      name: 'Row',
      elements: [],
    });
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
  });

  it('rejects cyclic or forward parents, duplicate IDs and invalid DOM associations', () => {
    for (const patch of [
      { parent: 1 },
      { parent: 2 },
      { id: 0 },
      { elements: [2] },
      { elements: [0] },
    ]) {
      const value = fixture();
      Object.assign(value.trees[0]!.nodes[1]!, patch);
      expect(parseComponentSnapshot(value, 2)).toBeUndefined();
    }
  });

  it('accepts source positions without exporting maps or source contents', () => {
    const value = fixture();
    Object.assign(value.trees[0]!.nodes[1]!, {
      source: {
        file: 'src/Row.tsx',
        line: 12,
        column: 4,
        provenance: 'compiler',
        sourcesContent: 'SECRET',
      },
    });
    const parsed = parseComponentSnapshot(value, 2);
    expect(parsed?.trees[0]?.nodes[1]?.source).toEqual({
      file: 'src/Row.tsx',
      line: 12,
      column: 4,
      provenance: 'compiler',
    });
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
  });

  it('rejects absolute, traversing, URL and encoded source paths', () => {
    for (const file of [
      '/Users/private/Row.tsx',
      'C:\\private\\Row.tsx',
      '../Row.tsx',
      'src/../Row.tsx',
      'https://example.com/a',
      'src/%2e%2e/private',
      'src/Row.tsx?token=secret',
    ]) {
      const value = fixture();
      Object.assign(value.trees[0]!.nodes[1]!, {
        source: { file, provenance: 'compiler' },
      });
      expect(parseComponentSnapshot(value, 2)).toBeUndefined();
    }
  });

  it('does not accept component names in an unavailable masked capture', () => {
    const value = fixture();
    Object.assign(value.trees[0]!, { status: 'unavailable', reason: 'masked' });
    expect(parseComponentSnapshot(value, 2)).toBeUndefined();
    value.trees[0]!.nodes = [];
    expect(parseComponentSnapshot(value, 2)?.trees[0]?.reason).toBe('masked');
  });

  it('requires explicit incomplete evidence and bounds framework collections', () => {
    const value = fixture();
    value.trees[0]!.status = 'partial';
    expect(parseComponentSnapshot(value, 2)).toBeUndefined();
    Object.assign(value.trees[0]!, { reason: 'budget-exceeded', truncated: true });
    expect(parseComponentSnapshot(value, 2)?.trees[0]?.status).toBe('partial');
    value.trees.push(value.trees[0]!);
    expect(parseComponentSnapshot(value, 2)).toBeUndefined();
  });
  it('bounds the persisted UTF-8 size, including multibyte component names', () => {
    const value = fixture();
    value.trees[0]!.nodes = Array.from({ length: 1024 }, (_, id) => ({
      id,
      parent: null,
      name: '界'.repeat(120),
      elements: [],
    }));
    expect(parseComponentSnapshot(value, 0)).toBeUndefined();
  });
});
