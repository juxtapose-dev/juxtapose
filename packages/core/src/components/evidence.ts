/** Diagnostic metadata only: never part of image or structural verdict hashes. */
export interface ComponentSource {
  file: string;
  line?: number;
  column?: number;
  provenance: 'compiler' | 'runtime' | 'sourcemap';
}

export interface ComponentNode {
  /** Snapshot-local identity; repeated names are distinct instances. */
  id: number;
  parent: number | null;
  name?: string;
  source?: ComponentSource;
  /** Direct associations into the accompanying retained DOM elements. */
  elements: number[];
}

export interface ComponentTree {
  framework: 'react' | 'vue' | 'svelte';
  runtimeVersion?: string;
  parentRelation: 'rendered-parent' | 'instrumented-context';
  elementRelation: 'rendered-by' | 'declared-by';
  coverage: 'runtime' | 'instrumented-only';
  status: 'available' | 'partial' | 'unavailable';
  reason?:
    | 'not-detected'
    | 'instrumentation-required'
    | 'unsupported-runtime'
    | 'capture-failed'
    | 'budget-exceeded'
    | 'dom-changed'
    | 'masked';
  truncated: boolean;
  nodes: ComponentNode[];
}

export interface ComponentSnapshot {
  schema: 'juxtapose.components/v1';
  trees: ComponentTree[];
}

const reasons = new Set([
  'not-detected',
  'instrumentation-required',
  'unsupported-runtime',
  'capture-failed',
  'budget-exceeded',
  'dom-changed',
  'masked',
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  );
}

function sourcePosition(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 10_000_000
  );
}

function parseSource(value: unknown): ComponentSource | undefined {
  if (
    !record(value) ||
    !boundedText(value.file, 512) ||
    /[\\:%?#]/u.test(value.file) ||
    value.file.split('/').some((part) => !part || part === '.' || part === '..') ||
    (value.provenance !== 'compiler' &&
      value.provenance !== 'runtime' &&
      value.provenance !== 'sourcemap') ||
    (value.line !== undefined && !sourcePosition(value.line)) ||
    (value.column !== undefined &&
      (!sourcePosition(value.column) || value.line === undefined))
  )
    return undefined;
  return {
    file: value.file,
    provenance: value.provenance,
    ...(value.line !== undefined ? { line: value.line } : {}),
    ...(value.column !== undefined ? { column: value.column } : {}),
  };
}

function parseTree(value: unknown, elementCount: number): ComponentTree | undefined {
  if (
    !record(value) ||
    (value.framework !== 'react' &&
      value.framework !== 'vue' &&
      value.framework !== 'svelte') ||
    (value.status !== 'available' &&
      value.status !== 'partial' &&
      value.status !== 'unavailable') ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 1024 ||
    (value.runtimeVersion !== undefined && !boundedText(value.runtimeVersion, 64)) ||
    (value.reason !== undefined &&
      (typeof value.reason !== 'string' || !reasons.has(value.reason)))
  )
    return undefined;
  const instrumented = value.framework === 'svelte';
  if (
    value.parentRelation !==
      (instrumented ? 'instrumented-context' : 'rendered-parent') ||
    value.elementRelation !== (instrumented ? 'declared-by' : 'rendered-by') ||
    value.coverage !== (instrumented ? 'instrumented-only' : 'runtime')
  )
    return undefined;
  if (
    value.status === 'available'
      ? value.reason !== undefined || value.truncated
      : value.reason === undefined
  )
    return undefined;
  if (value.status === 'unavailable' && (value.nodes.length !== 0 || value.truncated))
    return undefined;
  if (value.reason === 'masked' && value.status !== 'unavailable') return undefined;
  const nodes: ComponentNode[] = [];
  const owned = new Set<number>();
  for (const raw of value.nodes) {
    if (
      !record(raw) ||
      raw.id !== nodes.length ||
      (raw.parent !== null &&
        (typeof raw.parent !== 'number' ||
          !Number.isInteger(raw.parent) ||
          raw.parent < 0 ||
          raw.parent >= nodes.length)) ||
      (raw.name !== undefined && !boundedText(raw.name, 120)) ||
      !Array.isArray(raw.elements) ||
      raw.elements.length > elementCount
    )
      return undefined;
    const elements: number[] = [];
    for (const index of raw.elements) {
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= elementCount ||
        owned.has(index)
      )
        return undefined;
      owned.add(index);
      elements.push(index);
    }
    const source = raw.source === undefined ? undefined : parseSource(raw.source);
    if (raw.source !== undefined && !source) return undefined;
    nodes.push({
      id: nodes.length,
      parent: raw.parent,
      ...(raw.name !== undefined ? { name: raw.name } : {}),
      ...(source ? { source } : {}),
      elements,
    });
  }
  return {
    framework: value.framework,
    status: value.status,
    truncated: value.truncated,
    parentRelation: instrumented ? 'instrumented-context' : 'rendered-parent',
    elementRelation: instrumented ? 'declared-by' : 'rendered-by',
    coverage: instrumented ? 'instrumented-only' : 'runtime',
    ...(value.runtimeVersion !== undefined
      ? { runtimeVersion: value.runtimeVersion }
      : {}),
    ...(value.reason !== undefined
      ? { reason: value.reason as ComponentTree['reason'] }
      : {}),
    nodes,
  };
}

/** Copies only bounded diagnostic fields; application state is never retained. */
export function parseComponentSnapshot(
  value: unknown,
  elementCount: number,
): ComponentSnapshot | undefined {
  if (
    !Number.isInteger(elementCount) ||
    elementCount < 0 ||
    elementCount > 5000 ||
    !record(value) ||
    value.schema !== 'juxtapose.components/v1' ||
    !Array.isArray(value.trees) ||
    value.trees.length > 3
  )
    return undefined;
  const trees: ComponentTree[] = [];
  for (const raw of value.trees) {
    const tree = parseTree(raw, elementCount);
    if (!tree || trees.some((existing) => existing.framework === tree.framework))
      return undefined;
    trees.push(tree);
  }
  const result: ComponentSnapshot = { schema: 'juxtapose.components/v1', trees };
  // Bound persisted metadata as well as traversal, including escaped text.
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= 256 * 1024
    ? result
    : undefined;
}
