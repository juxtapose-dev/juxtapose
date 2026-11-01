import { describe, expect, it } from 'vitest';
import type { ComponentSnapshot } from './evidence.js';
import { projectComponents } from './projection.js';

const fixture = (): ComponentSnapshot => ({
  schema: 'juxtapose.components/v1',
  trees: [
    {
      framework: 'react',
      parentRelation: 'rendered-parent',
      elementRelation: 'rendered-by',
      coverage: 'runtime',
      status: 'available',
      truncated: false,
      nodes: [
        { id: 0, parent: null, name: 'App', elements: [0] },
        { id: 1, parent: 0, name: 'Unchanged', elements: [1] },
        { id: 2, parent: 0, name: 'Changed', elements: [2, 3] },
        { id: 3, parent: 0, name: 'NoRetainedDOM', elements: [] },
      ],
    },
  ],
});
describe('hosted component projection', () => {
  it('prioritizes retained DOM owners with their real ancestry and remaps local IDs', () => {
    const projected = projectComponents(fixture(), new Set([2]), 2, false);
    expect(projected?.trees[0]).toMatchObject({
      status: 'partial',
      reason: 'budget-exceeded',
      truncated: true,
      nodes: [
        { id: 0, parent: null, name: 'App', elements: [] },
        { id: 1, parent: 0, name: 'Changed', elements: [2] },
      ],
    });
  });
  it('preserves complete trees and zero-association instances when budget allows', () => {
    const value = fixture();
    expect(projectComponents(value, new Set([0, 1, 2, 3]), 100, false)).toEqual(value);
  });
  it('suppresses all framework identities behind masks', () => {
    const projected = projectComponents(fixture(), new Set([0, 1, 2, 3]), 100, true);
    expect(projected?.trees[0]).toMatchObject({
      status: 'unavailable',
      reason: 'masked',
      truncated: false,
      nodes: [],
    });
    expect(JSON.stringify(projected)).not.toContain('App');
  });
  it('preserves unavailable evidence instead of inventing an empty component tree', () => {
    const value = fixture();
    value.trees[0] = {
      ...value.trees[0]!,
      status: 'unavailable',
      reason: 'not-detected',
      nodes: [],
    };
    expect(projectComponents(value, new Set(), 100, false)).toEqual(value);
    expect(projectComponents(undefined, new Set(), 100, false)).toBeUndefined();
  });
});
