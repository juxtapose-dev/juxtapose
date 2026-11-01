import { expect, test } from 'vitest';
import { normalizeRuntimeComponents } from './normalize.js';
import type { VueComponentSnapshot } from './vue.js';
const vue = (): VueComponentSnapshot => ({
  framework: 'vue',
  relation: 'rendered-parent',
  status: 'ok',
  truncated: false,
  nodes: [
    { id: 'vue:0', parent: null, name: 'App', elements: [0] },
    { id: 'vue:1', parent: 'vue:0', name: 'Row', elements: [1] },
  ],
});
test('normalizes capture-local IDs and remaps compact DOM indices', () => {
  expect(normalizeRuntimeComponents([vue()], [1, 3], 4)?.trees[0]?.nodes).toEqual([
    { id: 0, parent: null, name: 'App', elements: [1] },
    { id: 1, parent: 0, name: 'Row', elements: [3] },
  ]);
  expect(normalizeRuntimeComponents([vue()], [1], 4)).toBeUndefined();
});
test('retains explicit unavailable and incomplete diagnostic outcomes', () => {
  const value = vue();
  value.status = 'partial';
  value.reason = 'limit';
  value.truncated = true;
  expect(normalizeRuntimeComponents([value], [0, 1], 2)?.trees[0]).toMatchObject({
    status: 'partial',
    reason: 'budget-exceeded',
    truncated: true,
  });
  value.status = 'unavailable';
  value.reason = 'masked';
  value.nodes = [];
  value.truncated = false;
  expect(normalizeRuntimeComponents([value], [], 0)?.trees[0]).toMatchObject({
    status: 'unavailable',
    reason: 'masked',
    nodes: [],
  });
});
test('rejects dangling parents and duplicate collector identities', () => {
  const value = vue();
  value.nodes[1]!.parent = 'missing';
  expect(normalizeRuntimeComponents([value], [0, 1], 2)).toBeUndefined();
  value.nodes[1]!.parent = 'vue:0';
  value.nodes[1]!.id = 'vue:0';
  expect(normalizeRuntimeComponents([value], [0, 1], 2)).toBeUndefined();
});

test('rejects duplicate root IDs even without parent references', () => {
  const value = vue();
  value.nodes[1]!.id = 'vue:0';
  value.nodes[1]!.parent = null;
  expect(normalizeRuntimeComponents([value], [0, 1], 2)).toBeUndefined();
});

test('preserves Svelte instrumented context and declared ownership without inventing completeness', () => {
  const result = normalizeRuntimeComponents(
    [
      {
        framework: 'svelte',
        relation: 'instrumented-context',
        elementRelation: 'declared-by',
        status: 'partial',
        reason: 'instrumented-components-only',
        truncated: false,
        nodes: [
          {
            id: 's1',
            parent: null,
            name: 'App',
            source: { file: 'src/App.svelte', provenance: 'compiler' },
            elements: [0],
          },
        ],
      },
    ],
    [2],
    3,
  );
  expect(result?.trees[0]).toMatchObject({
    framework: 'svelte',
    parentRelation: 'instrumented-context',
    elementRelation: 'declared-by',
    coverage: 'instrumented-only',
    status: 'partial',
    reason: 'instrumented-components-only',
    truncated: false,
    nodes: [
      {
        id: 0,
        parent: null,
        name: 'App',
        source: { file: 'src/App.svelte', provenance: 'compiler' },
        elements: [2],
      },
    ],
  });
});
