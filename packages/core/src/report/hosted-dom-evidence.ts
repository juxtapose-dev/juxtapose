import type { StructureSnapshot, StructureElement } from '../types.js';
import { hashElements, STRUCTURE_PROPS } from '../capture/structure.js';
import { matchElements } from '../diff/structural/match.js';
import { computeFacts } from '../diff/structural/deltas.js';
import { label } from '../diff/structural/label.js';
import {
  parseComponentSnapshot,
  type ComponentSnapshot,
} from '../components/evidence.js';
import { projectComponents } from '../components/projection.js';

interface Node {
  index: number;
  parentIndex: number | null;
  selector: string;
  label: string;
  tag: string;
  rect: { x: number; y: number; w: number; h: number };
  text?: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
}
interface Element {
  index: number;
  selector: string;
  label: string;
  rect: Node['rect'];
  ancestors: Array<{ selector: string; label: string }>;
}
export interface HostedDomEvidence {
  components?: { baseline?: ComponentSnapshot; current?: ComponentSnapshot };
  schema: 'juxtapose.dom-evidence/v1';
  baselineStructureHash: string;
  currentStructureHash: string;
  baselineViewport: { width: number; height: number };
  currentViewport: { width: number; height: number };
  totalChanges: number;
  truncated: boolean;
  trees: {
    baseline: { nodes: Node[]; totalNodes: number; truncated: boolean };
    current: { nodes: Node[]; totalNodes: number; truncated: boolean };
    matches: Array<{ baselineIndex: number; currentIndex: number }>;
  };
  changes: Array<{
    id: string;
    kind: string;
    description: string;
    baseline?: Element;
    current?: Element;
    regionIndices: number[];
  }>;
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const controls = new Set(['input', 'textarea', 'select', 'option']);
const safeText = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' &&
  !/(?:https?:\/\/|javascript:|data:|url\s*\(|[?&][^\s]+\s*=)/i.test(value)
    ? value.slice(0, limit)
    : undefined;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
function sanitize(input: StructureSnapshot): StructureSnapshot | undefined {
  if (
    !record(input) ||
    input.schema !== 'juxtapose.structure/v1' ||
    !Array.isArray(input.elements) ||
    input.elements.length > 5000 ||
    !record(input.viewport) ||
    !finite(input.viewport.width) ||
    !finite(input.viewport.height) ||
    input.viewport.width <= 0 ||
    input.viewport.height <= 0 ||
    input.viewport.width > 100000 ||
    input.viewport.height > 100000
  )
    return;
  if (
    input.truncated &&
    (!record(input.truncated) ||
      !Number.isInteger(input.truncated.total) ||
      input.truncated.total < input.elements.length ||
      input.truncated.total > 100000 ||
      input.truncated.kept !== input.elements.length)
  )
    return;
  const elements: StructureElement[] = [];
  for (const [index, raw] of input.elements.entries()) {
    if (
      !record(raw) ||
      typeof raw.path !== 'string' ||
      typeof raw.tag !== 'string' ||
      raw.tag.length < 1 ||
      raw.tag.length > 80 ||
      raw.tag !== raw.tag.toLowerCase() ||
      !record(raw.rect) ||
      !(['x', 'y', 'w', 'h'] as const).every((k) => finite(raw.rect[k])) ||
      raw.rect.w < 0 ||
      raw.rect.h < 0 ||
      !record(raw.styles) ||
      !(
        raw.parent === null ||
        (Number.isInteger(raw.parent) && raw.parent >= 0 && raw.parent < index)
      ) ||
      (raw.parent !== null && elements[raw.parent]?.tag === 'masked')
    )
      return;
    const masked = raw.tag === 'masked';
    const control = controls.has(raw.tag);
    const styles = masked
      ? {}
      : Object.fromEntries(
          STRUCTURE_PROPS.filter(
            (key) => key !== 'content' && safeText(raw.styles[key], 1000) !== undefined,
          )
            .slice(0, 64)
            .map((key) => [key, safeText(raw.styles[key], 1000)!]),
        );
    elements.push({
      path: masked ? `masked:nth-node(${index})` : (safeText(raw.path, 4096) ?? raw.tag),
      parent: raw.parent,
      tag: raw.tag,
      rect: {
        x: raw.rect.x,
        y: raw.rect.y,
        w: raw.rect.w,
        h: raw.rect.h,
      },
      paintOrder: 0,
      styles,
      ...(!masked && safeText(raw.id, 200) ? { id: safeText(raw.id, 200)! } : {}),
      ...(!masked && safeText(raw.testId, 200)
        ? { testId: safeText(raw.testId, 200)! }
        : {}),
      ...(!masked && safeText(raw.role, 80) ? { role: safeText(raw.role, 80)! } : {}),
      ...(!masked && !control && safeText(raw.name, 120)
        ? { name: safeText(raw.name, 120)! }
        : {}),
      ...(!masked && !control && safeText(raw.text, 1000)
        ? { text: safeText(raw.text, 1000)! }
        : {}),
      ...(!masked && Array.isArray(raw.classes)
        ? {
            classes: raw.classes
              .map((value) => safeText(value, 80))
              .filter((v): v is string => v !== undefined)
              .slice(0, 8),
          }
        : {}),
    });
  }
  if (
    !/^[a-f0-9]{64}$/.test(input.structureHash) ||
    hashElements(input.elements) !== input.structureHash
  )
    return;
  return { ...input, elements };
}
function identity(snapshot: StructureSnapshot, index: number): Element {
  const el = snapshot.elements[index]!;
  const ancestors: Element['ancestors'] = [];
  let parent = el.parent;
  while (parent !== null && ancestors.length < 8) {
    const ancestor = snapshot.elements[parent]!;
    ancestors.unshift({ selector: ancestor.path, label: label(ancestor).slice(0, 120) });
    parent = ancestor.parent;
  }
  return {
    index,
    selector: el.path,
    label: label(el).slice(0, 120),
    rect: el.rect,
    ancestors,
  };
}
/** Structure hashes refer to the original verified snapshots; trees are a sanitized projection.
 * Optional diagnostic evidence only: never changes a pixel verdict or an approval. */
export function buildHostedDomEvidence(
  baseline: StructureSnapshot,
  current: StructureSnapshot,
  maxBytes = 64 * 1024,
): HostedDomEvidence | undefined {
  if (maxBytes < 1024) return;
  try {
    const a = sanitize(baseline),
      b = sanitize(current);
    if (!a || !b || !a.elements.length || !b.elements.length) return;
    const componentA = parseComponentSnapshot(a.components, a.elements.length);
    const componentB = parseComponentSnapshot(b.components, b.elements.length);
    const maskedA = a.elements.some((element) => element.tag === 'masked');
    const maskedB = b.elements.some((element) => element.tag === 'masked');
    const matches = matchElements(a, b),
      forward = new Map(matches.pairs),
      reverse = new Map(matches.pairs.map(([i, j]) => [j, i]));
    const facts = computeFacts(a, b, matches).filter(
      (f) =>
        !(f.delta.kind === 'removed' && b.truncated) &&
        !(f.delta.kind === 'added' && a.truncated),
    );
    const priorityA = new Set<number>(),
      priorityB = new Set<number>();
    const add = (snapshot: StructureSnapshot, set: Set<number>, index: number) => {
      let cursor: number | null = index;
      while (cursor !== null && !set.has(cursor)) {
        set.add(cursor);
        cursor = snapshot.elements[cursor]!.parent;
      }
    };
    for (const fact of facts.slice(0, 100)) {
      if (fact.source.side === 'baseline') {
        add(a, priorityA, fact.source.index);
        const j = forward.get(fact.source.index);
        if (j !== undefined) add(b, priorityB, j);
      } else add(b, priorityB, fact.source.index);
    }
    const select = (
      snapshot: StructureSnapshot,
      priority: Set<number>,
      limit: number,
    ) => {
      const included = new Set<number>();
      for (const i of [...priority, ...snapshot.elements.keys()]) {
        const needed: number[] = [];
        let cursor: number | null = i;
        while (cursor !== null && !included.has(cursor)) {
          needed.unshift(cursor);
          cursor = snapshot.elements[cursor]!.parent;
        }
        if (included.size + needed.length <= limit)
          for (const index of needed) included.add(index);
      }
      return [...included].sort((x, y) => x - y);
    };
    for (let limit = 100; limit >= 1; limit--) {
      const ai = select(a, priorityA, limit),
        bi = select(b, priorityB, limit),
        as = new Set(ai),
        bs = new Set(bi);
      if (!ai.length || !bi.length) continue;
      const tree = (snapshot: StructureSnapshot, indices: number[]) => ({
        nodes: indices.map((index) => {
          const el = snapshot.elements[index]!;
          return {
            index,
            parentIndex: el.parent,
            selector: el.path,
            label: label(el).slice(0, 120),
            tag: el.tag,
            rect: el.rect,
            ...(el.text ? { text: el.text } : {}),
            attributes:
              el.tag === 'masked'
                ? {}
                : Object.fromEntries(
                    [
                      ['id', el.id],
                      ['data-testid', el.testId],
                      ['role', el.role],
                      ['class', el.classes?.join(' ')],
                    ].filter(
                      (entry): entry is [string, string] => typeof entry[1] === 'string',
                    ),
                  ),
            styles: el.styles,
          };
        }),
        totalNodes: snapshot.truncated?.total ?? snapshot.elements.length,
        truncated: !!snapshot.truncated || indices.length < snapshot.elements.length,
      });
      const changes: HostedDomEvidence['changes'] = [];
      for (const fact of facts) {
        if (changes.length >= 100) break;
        const i =
            fact.source.side === 'baseline'
              ? fact.source.index
              : reverse.get(fact.source.index),
          j =
            fact.source.side === 'current'
              ? fact.source.index
              : forward.get(fact.source.index);
        if ((i !== undefined && !as.has(i)) || (j !== undefined && !bs.has(j))) continue;
        const d = fact.delta,
          subject = d.kind === 'shift' ? d.after : d.el;
        const description =
          d.kind === 'text'
            ? `${subject}: text changed`
            : d.kind === 'style'
              ? `${subject}: ${d.prop} changed from ${d.from} to ${d.to}`
              : d.kind === 'attr'
                ? `${subject}: ${d.attr} changed`
                : `${subject}: ${d.kind}`;
        changes.push({
          id: `D${changes.length + 1}`,
          kind: d.kind,
          description: description.slice(0, 1000),
          ...(i !== undefined ? { baseline: identity(a, i) } : {}),
          ...(j !== undefined ? { current: identity(b, j) } : {}),
          regionIndices: [],
        });
      }
      const trees = {
        baseline: tree(a, ai),
        current: tree(b, bi),
        matches: matches.pairs
          .filter(([i, j]) => as.has(i) && bs.has(j))
          .slice(0, 100)
          .map(([baselineIndex, currentIndex]) => ({ baselineIndex, currentIndex })),
      };
      const projectedA = projectComponents(componentA, as, limit, maskedA);
      const projectedB = projectComponents(componentB, bs, limit, maskedB);
      const evidence: HostedDomEvidence = {
        ...(projectedA || projectedB
          ? {
              components: {
                ...(projectedA ? { baseline: projectedA } : {}),
                ...(projectedB ? { current: projectedB } : {}),
              },
            }
          : {}),
        schema: 'juxtapose.dom-evidence/v1',
        baselineStructureHash: baseline.structureHash,
        currentStructureHash: current.structureHash,
        baselineViewport: baseline.viewport,
        currentViewport: current.viewport,
        totalChanges: facts.length,
        truncated:
          trees.baseline.truncated ||
          trees.current.truncated ||
          changes.length < facts.length,
        trees,
        changes,
      };
      if (size(evidence) <= Math.min(maxBytes, 64 * 1024)) return evidence;
    }
  } catch {
    /* Missing/corrupt optional DOM must not break complete image uploads. */
  }
}
