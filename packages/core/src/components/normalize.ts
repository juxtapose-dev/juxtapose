import {
  parseComponentSnapshot,
  type ComponentSnapshot,
  type ComponentTree,
} from './evidence.js';
import type { ReactComponentSnapshot } from './react.js';
import type { VueComponentSnapshot } from './vue.js';
import type { SvelteComponentEvidence } from '../capture/svelte-component-runtime.js';
type RuntimeComponents =
  ReactComponentSnapshot | VueComponentSnapshot | SvelteComponentEvidence;

function normalizedReason(reason: RuntimeComponents['reason']): ComponentTree['reason'] {
  switch (reason) {
    case undefined:
    case null:
      return undefined;
    case 'masked':
      return 'masked';
    case 'unsupported_runtime':
      return 'unsupported-runtime';
    case 'runtime_hooks_unavailable':
    case 'not-instrumented':
      return 'instrumentation-required';
    case 'instrumented-components-only':
      return 'instrumented-components-only';
    case 'provider_missing':
    case 'no_roots':
      return 'not-detected';
    default:
      return reason === 'limit' || reason.endsWith('_limit')
        ? 'budget-exceeded'
        : 'capture-failed';
  }
}

/** Convert collector-local indices to the verified DOM capture indices. */
export function normalizeRuntimeComponents(
  snapshots: readonly RuntimeComponents[],
  indices: readonly number[],
  elementCount: number,
): ComponentSnapshot | undefined {
  if (
    snapshots.length > 3 ||
    indices.length > 5000 ||
    snapshots.some(
      (snapshot) =>
        snapshot.nodes.length > 1024 ||
        new Set(snapshot.nodes.map((node) => node.id)).size !== snapshot.nodes.length,
    )
  )
    return undefined;
  const trees: ComponentTree[] = snapshots.map((snapshot) => {
    const ids = new Map<string | number, number>(
      snapshot.nodes.map((node, index) => [node.id, index]),
    );
    const reason = normalizedReason(snapshot.reason);
    const instrumented = snapshot.framework === 'svelte';
    const status =
      snapshot.status === 'unavailable'
        ? 'unavailable'
        : reason
          ? 'partial'
          : 'available';
    return {
      framework: snapshot.framework,
      ...(snapshot.runtimeVersion ? { runtimeVersion: snapshot.runtimeVersion } : {}),
      parentRelation: instrumented ? 'instrumented-context' : 'rendered-parent',
      elementRelation: instrumented ? 'declared-by' : 'rendered-by',
      coverage: instrumented ? 'instrumented-only' : 'runtime',
      status,
      ...(reason ? { reason } : {}),
      truncated: status === 'unavailable' ? false : snapshot.truncated,
      nodes: snapshot.nodes.map((node, id) => ({
        id,
        parent: node.parent === null ? null : (ids.get(node.parent) ?? -1),
        ...(node.name ? { name: node.name.slice(0, 120) } : {}),
        ...('source' in node && node.source ? { source: node.source } : {}),
        elements: node.elements.map((index) => indices[index] ?? -1),
      })),
    };
  });
  return parseComponentSnapshot(
    { schema: 'juxtapose.components/v1', trees },
    elementCount,
  );
}
