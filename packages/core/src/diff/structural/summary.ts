// Deterministic prose. No model, no adjectives: the classification, the
// changes that caused it, and whether they account for the pixels. 300 chars,
// met by construction: labels and values are capped, the tail is reserved
// first, and each clause has shorter forms down to `el prop changed`, so the
// hard cut at the end is a backstop no input reaches.
//
// The summary is the line an agent reads first, so it leads with causes
// (text, attr, style, added, removed) and only then consequences (shift,
// resize, move). Fact order is document order, which puts `main resized` —
// a consequence of every reflow — first; read as-is, five of the 18 corpus
// summaries opened with it and the actual change came second or third.

import type {
  ChangedRegion,
  Classification,
  Delta,
  Flag,
  StructureSnapshot,
  StyleTag,
} from '../../types.js';
import { selfPaintingAt } from './classify.js';
import { clip, label } from './label.js';

export const MAX_SUMMARY = 300;
/** `change`: the summary's lead clauses without the per-story tail. */
export const MAX_CHANGE = 160;
const CHANGE_ITEMS = 2;
const LEAD_ITEMS = 3;
/** Changes listed in one element's clause; the rest join "(+N more)". */
const CLAUSE_CHANGES = 3;
/** Longest value shown in prose. Not deltas.ts's MAX_VALUE (200), which caps
 *  what the JSON stores; this caps what a sentence repeats of it. */
const MAX_SHOWN_VALUE = 40;

export function describeDelta(d: Delta): string {
  switch (d.kind) {
    case 'text':
    case 'style':
    case 'attr':
      return `${d.el} ${change(d)}`;
    case 'added':
      return `added ${d.el} (${d.rect.w}×${d.rect.h} at ${d.rect.x},${d.rect.y})`;
    case 'removed':
      return `removed ${d.el} (${d.rect.w}×${d.rect.h} at ${d.rect.x},${d.rect.y})`;
    case 'moved':
      return `${d.el} moved ${direction(d.dx, d.dy)}`;
    case 'resized':
      return `${d.el} resized ${extent(d.dw, d.dh)}`;
    case 'shift':
      return `${d.count} elements after ${d.after} moved ${direction(d.dx, d.dy)}`;
  }
}

/** The deltas as indented display lines for a human, grouped by element:
 *  the element's content changes (four-side longhands collapsed), then its
 *  resize and move on one line. Groups run causes first — content, added and
 *  removed, and a move a shift is blamed on; then shifts; then other moves;
 *  then resizes, so an ancestor's consequential `resized` comes last. Every
 *  delta passed in is stated on some line; `total` is the verdict's
 *  `deltaCount`, which says whether `deltas` is the whole set. */
export function describeDeltas(deltas: Delta[], total = deltas.length): string[] {
  const ctx = context(deltas, total);
  const lines: string[] = [];
  const ordered = groupByElement(deltas)
    .map((g, i) => ({ g, i, rank: groupRank(g, ctx) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  for (const { g } of ordered) {
    if (g.solo !== undefined) {
      lines.push(`  ${describe(g.solo, ctx)}`);
      continue;
    }
    const effects = [
      g.resized && `resized ${extent(g.resized.dw, g.resized.dh)}`,
      g.moved && `moved ${direction(g.moved.dx, g.moved.dy)}`,
    ].filter((x): x is string => typeof x === 'string');
    const own = [
      ...shorthand(g.content, ' → ').map((p) => p.text),
      ...(effects.length ? [effects.join(', ')] : []),
    ];
    if (own.length === 1) lines.push(`  ${g.el} ${own[0]}`);
    else {
      lines.push(`  ${g.el}`);
      for (const l of own) lines.push(`    ${l}`);
    }
  }
  return lines;
}

type Moved = Extract<Delta, { kind: 'moved' }>;
type Resized = Extract<Delta, { kind: 'resized' }>;

/** One element's deltas, or one delta that stands alone. */
interface Group {
  el?: string;
  content: ContentDelta[];
  resized?: Resized;
  moved?: Moved;
  solo?: Delta;
}

/** Facts about one element are adjacent in `deltas` (they sort by element
 *  position first) and, since `disambiguate`, distinct elements never share
 *  a label — so an element is a run of one label, not every delta with that
 *  label. The run also splits when a kind or property repeats, which only an
 *  older verdict with colliding labels can produce: two elements, never one
 *  element stating `background-color` twice. */
function groupByElement(deltas: Delta[]): Group[] {
  const groups: Group[] = [];
  let open: { g: Group; seen: Set<string> } | undefined;
  for (const d of deltas) {
    if (d.kind === 'added' || d.kind === 'removed' || d.kind === 'shift') {
      groups.push({ content: [], solo: d });
      open = undefined;
      continue;
    }
    const fact =
      d.kind === 'style'
        ? `style:${d.prop}`
        : d.kind === 'attr'
          ? `attr:${d.attr}`
          : d.kind;
    if (!open || open.g.el !== d.el || open.seen.has(fact)) {
      open = { g: { el: d.el, content: [] }, seen: new Set() };
      groups.push(open.g);
    }
    open.seen.add(fact);
    if (d.kind === 'moved') open.g.moved = d;
    else if (d.kind === 'resized') open.g.resized = d;
    else open.g.content.push(d);
  }
  return groups;
}

/** What ranking and wording need to know about the whole delta set. */
interface Context {
  /** Labels a shift is blamed on (`after`) that changed in no other way: a
   *  move there is the cause. */
  anchors: Set<string>;
  /** How many moves and shifts carry each displacement. */
  displacements: Map<string, number>;
  /** Nothing moved or resized, and `deltas` is the whole set. */
  still: boolean;
}

const disp = (d: { dx: number; dy: number }) => `${d.dx},${d.dy}`;

function context(deltas: Delta[], total: number): Context {
  const anchors = new Set<string>();
  const displacements = new Map<string, number>();
  // An element with its own content change is the cause through that change
  // (padding grew); its move is a consequence like any other.
  const changed = new Set(
    deltas
      .filter(
        (d): d is ContentDelta =>
          d.kind === 'text' || d.kind === 'style' || d.kind === 'attr',
      )
      .map((d) => d.el),
  );
  for (const d of deltas) {
    if (d.kind === 'shift' && !changed.has(d.after)) anchors.add(d.after);
    if (d.kind === 'shift' || d.kind === 'moved')
      displacements.set(disp(d), (displacements.get(disp(d)) ?? 0) + 1);
  }
  const still =
    total === deltas.length &&
    !deltas.some((d) => d.kind === 'shift' || d.kind === 'moved' || d.kind === 'resized');
  return { anchors, displacements, still };
}

/** A move a shift names as its cause (a reordered item) reads with the
 *  causes; a move with a displacement nothing else shares reads before ones
 *  that are part of a crowd. */
function moveRank(d: Moved, ctx: Context): number {
  if (ctx.anchors.has(d.el)) return 0.5;
  return (ctx.displacements.get(disp(d)) ?? 0) > 1 ? 3.5 : 3;
}

function groupRank(g: Group, ctx: Context): number {
  if (g.solo) return g.solo.kind === 'shift' ? 1 : 0;
  if (g.content.length) return 0;
  // 0.5 (blamed by a shift), else 2 or 2.5: after shifts, before resizes.
  if (g.moved) {
    const r = moveRank(g.moved, ctx);
    return r === 0.5 ? r : r - 1;
  }
  return 4;
}

/** `describeDelta`, except that a removal with nothing moving or resizing
 *  around it may not be a removal: the capture drops `visibility: hidden`
 *  boxes, which leave their space behind. `display: none` and a real removal
 *  reflow what follows; this does not. The JSON `kind` stays `removed` —
 *  that is what the structure says — only the prose hedges. */
function describe(d: Delta, ctx: Context): string {
  if (d.kind === 'removed' && ctx.still)
    return `hidden or removed ${d.el} (${d.rect.w}×${d.rect.h} at ${d.rect.x},${d.rect.y})`;
  return describeDelta(d);
}

type ContentDelta = Extract<Delta, { kind: 'text' | 'style' | 'attr' }>;

/** `prop from→to`, without the element. */
function change(d: ContentDelta, arrow = '→'): string {
  if (d.kind === 'text') return `text "${trim(d.from)}"${arrow}"${trim(d.to)}"`;
  return `${changedName(d)} ${value(d.from)}${arrow}${value(d.to)}`;
}

const changedName = (d: ContentDelta) =>
  d.kind === 'style' ? d.prop : d.kind === 'attr' ? d.attr : 'text';

export interface SummaryArgs {
  classification: Classification;
  styleTags: StyleTag[];
  deltas: Delta[];
  deltaCount: number;
  regionCount: number;
  unexplainedRegions: ChangedRegion[];
  flags: Flag[];
  imagesIdentical: boolean;
  /** No pixel diff ran (the baseline image is unavailable): say nothing about
   *  regions or tolerance, only that the hash differs. */
  noPixelDiff?: boolean;
  baseline?: StructureSnapshot;
  current?: StructureSnapshot;
}

const headOf = (a: SummaryArgs) =>
  a.styleTags.length > 0
    ? `${a.classification} (${a.styleTags.join(', ')})`
    : a.classification;

/** The change alone, for naming what several stories share: the summary's
 *  own clause wording with every element reduced to its role|tag (the
 *  caller passes `deltas` already abstracted), no coverage or tolerance
 *  tail, at most two clauses. */
export function buildChange(a: SummaryArgs): string {
  return clip(lead(headOf(a), a, [], MAX_CHANGE, CHANGE_ITEMS), MAX_CHANGE);
}

const NO_PIXEL_DIFF = 'No pixel diff: the baseline image is unavailable';

export function buildSummary(a: SummaryArgs): string {
  const head = headOf(a);
  const subThreshold = a.flags.includes('sub-threshold');
  const missing = a.flags.includes('no-baseline-structure')
    ? 'baseline'
    : a.flags.includes('no-current-structure')
      ? 'current'
      : undefined;

  const tail: string[] = [];
  const trunc = [a.baseline, a.current].find((s) => s?.truncated)?.truncated;
  if (trunc) tail.push(`Structure truncated (${trunc.kept}/${trunc.total} elements)`);

  let body: string;
  if (a.classification === 'identical') {
    body = missing
      ? `identical: images byte-identical; no ${missing} structure to compare`
      : 'identical: images byte-identical, no structural change';
  } else if (a.classification === 'dimension-change') {
    // Regions do not exist across sizes, so there is no region tail here.
    const b = a.baseline && size(a.baseline);
    const c = a.current && size(a.current);
    body =
      b && c && b !== c
        ? `${head}: ${b} → ${c}; compare at one viewport`
        : b && c
          ? `${head}: image dimensions differ at the same ${b} viewport`
          : `${head}: image dimensions differ; no ${missing} structure to name the sizes`;
  } else if (missing) {
    body = `${head}: no ${missing} structure, so nothing explains the pixels; re-snap (or re-approve) with structure capture enabled`;
    tail.unshift(
      a.noPixelDiff
        ? NO_PIXEL_DIFF
        : subThreshold
          ? 'Pixel diff marks no region, which is not evidence the change is harmless'
          : `${a.regionCount} changed region${a.regionCount === 1 ? '' : 's'}`,
    );
  } else if (a.deltas.length === 0 && a.noPixelDiff) {
    body = `${head}: structure and styles identical; the hash differs, so pixels changed, but there is no baseline image to show where`;
    tail.unshift(NO_PIXEL_DIFF);
  } else if (a.deltas.length === 0) {
    const painter = a.current && selfPaintingAt(a.current, a.unexplainedRegions);
    body = painter
      ? `${head}: structure and styles identical; the change is inside ${label(painter)}, which paints its own pixels`
      : subThreshold
        ? `${head}: structure and styles identical; pixels differ below the diff's tolerance`
        : `${head}: structure and styles identical, pixels differ`;
    if (!subThreshold) tail.unshift(regions(a));
  } else {
    tail.unshift(
      a.noPixelDiff
        ? NO_PIXEL_DIFF
        : subThreshold
          ? 'Pixel diff below tolerance; structure explains it'
          : a.imagesIdentical
            ? 'Images byte-identical: the change paints nothing at this viewport'
            : regions(a),
    );
    body = lead(head, a, tail);
  }

  const out = [body, ...tail].join('. ') + '.';
  return clip(out, MAX_SUMMARY);
}

/** Up to LEAD_ITEMS clauses, causes first. Each clause takes the richest
 *  form that fits beside the reserved tail — a clause cut mid-value would
 *  misstate the change — and whatever is left over is counted in
 *  "(+N more)". */
function lead(
  head: string,
  a: SummaryArgs,
  tail: string[],
  max = MAX_SUMMARY,
  items = LEAD_ITEMS,
): string {
  const budget = max - tail.reduce((n, t) => n + t.length + 2, 0) - 1;
  const render = (texts: string[], more: number) =>
    `${head}: ${texts.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
  const shown: string[] = [];
  let used = 0;
  for (const item of leadItems(a.deltas, a.deltaCount).slice(0, items)) {
    const fit =
      item.find(
        (o) =>
          render([...shown, o.text], a.deltaCount - used - o.consumed).length <= budget,
      ) ?? (shown.length === 0 ? item.at(-1) : undefined);
    if (!fit) break;
    shown.push(fit.text);
    used += fit.consumed;
  }
  return render(shown, a.deltaCount - used);
}

/** One clause, in its alternative forms, richest first. */
type LeadItem = Array<{
  text: string;
  /** How many deltas this form states, for the "(+N more)" count. */
  consumed: number;
}>;

/** Causes before consequences; within a rank, fact (document) order. A
 *  move is ranked by `moveRank`. */
const CAUSE_RANK: Record<Delta['kind'], number> = {
  removed: 0,
  added: 0,
  text: 0,
  attr: 0,
  style: 0,
  shift: 1,
  resized: 2,
  moved: 3,
};

function leadItems(deltas: Delta[], total: number): LeadItem[] {
  const ctx = context(deltas, total);
  const rank = (d: Delta) => (d.kind === 'moved' ? moveRank(d, ctx) : CAUSE_RANK[d.kind]);
  // Content changes on one element read as one clause: `el a→b, c→d`; its
  // resize and move stay separate clauses, ranked as consequences.
  const items: Array<{ rank: number; i: number; item: LeadItem }> = [];
  for (const g of groupByElement(deltas)) {
    const i = items.length;
    if (g.solo) {
      items.push({
        rank: rank(g.solo),
        i,
        item: [{ text: describe(g.solo, ctx), consumed: 1 }],
      });
      continue;
    }
    if (g.content.length)
      items.push({ rank: 0, i, item: contentForms(g.el!, g.content) });
    for (const d of [g.resized, g.moved])
      if (d)
        items.push({
          rank: rank(d),
          i: items.length,
          item: [{ text: describeDelta(d), consumed: 1 }],
        });
  }
  return items.sort((x, y) => x.rank - y.rank || x.i - y.i).map((x) => x.item);
}

function contentForms(el: string, content: ContentDelta[]): LeadItem {
  const parts = shorthand(content);
  const forms: LeadItem = [];
  for (let k = Math.min(CLAUSE_CHANGES, parts.length); k >= 1; k--) {
    const some = parts.slice(0, k);
    forms.push({
      text: `${el} ${some.map((p) => p.text).join(', ')}`,
      consumed: some.reduce((n, p) => n + p.consumed, 0),
    });
  }
  // Callers pass non-empty content, and shorthand emits at least one part per
  // change it is given (a collapsed box stands in for its absorbed longhands).
  const first = parts[0]!;
  forms.push({ text: `${el} ${first.name} changed`, consumed: first.consumed });
  return forms;
}

interface Part {
  name: string;
  text: string;
  consumed: number;
}

/** CSS box properties whose four longhands collapse to one shorthand, in the
 *  shorthand's own value order (top, right, bottom, left / corners clockwise
 *  from top-left). */
const BOXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
  ['margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']],
  [
    'border-width',
    [
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
    ],
  ],
  [
    'border-color',
    [
      'border-top-color',
      'border-right-color',
      'border-bottom-color',
      'border-left-color',
    ],
  ],
  [
    'border-radius',
    [
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
    ],
  ],
];

/** One element's changes as `prop from→to` strings; when all four longhands
 *  of a box changed, they read as the shorthand (`padding 8px 12px→12px
 *  16px`), placed where the first of them was. */
function shorthand(changes: ContentDelta[], arrow = '→'): Part[] {
  const style = new Map<string, Extract<Delta, { kind: 'style' }>>();
  for (const c of changes) if (c.kind === 'style') style.set(c.prop, c);
  const collapsed = new Map<string, Part>(); // first longhand seen → clause
  const absorbed = new Set<string>();
  for (const [name, sides] of BOXES) {
    const four = sides
      .map((p) => style.get(p))
      .filter((d): d is Extract<Delta, { kind: 'style' }> => d !== undefined);
    if (four.length !== sides.length) continue;
    const first = changes.find((c) => c.kind === 'style' && sides.includes(c.prop));
    if (first?.kind !== 'style') continue;
    collapsed.set(first.prop, {
      name,
      text: `${name} ${value(boxValue(four.map((d) => d.from)))}${arrow}${value(boxValue(four.map((d) => d.to)))}`,
      consumed: 4,
    });
    for (const p of sides) absorbed.add(p);
  }
  const out: Part[] = [];
  for (const c of changes) {
    const box = c.kind === 'style' ? collapsed.get(c.prop) : undefined;
    if (box) out.push(box);
    else if (c.kind !== 'style' || !absorbed.has(c.prop))
      out.push({ name: changedName(c), text: change(c, arrow), consumed: 1 });
  }
  return out;
}

/** CSS shorthand value compression: `a a a a` → `a`, `a b a b` → `a b`,
 *  `a b c b` → `a b c`. */
function boxValue([t, r, b, l]: string[]): string {
  if (r === l) {
    if (t === b) return t === r ? t! : `${t} ${r}`; // BOXES sides are four longhands
    return `${t} ${r} ${b}`;
  }
  return `${t} ${r} ${b} ${l}`;
}

/** How many changed regions the structure accounts for, by count. */
function regions(a: SummaryArgs): string {
  const n = a.regionCount;
  const u = a.unexplainedRegions.length;
  const the =
    n === 1
      ? 'the changed region'
      : n === 2
        ? 'both changed regions'
        : `all ${n} changed regions`;
  if (u === 0) return `Structure explains ${the}`;
  if (u === n)
    return n === 1
      ? 'Nothing in the structure explains the changed region'
      : n === 2
        ? 'Nothing in the structure explains either changed region'
        : `Nothing in the structure explains the ${n} changed regions`;
  return `${u} of ${n} changed regions unexplained`;
}

const size = (s: StructureSnapshot) => `${s.viewport.width}×${s.viewport.height}`;
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const trim = (s: string) => clip(s, MAX_SHOWN_VALUE);

/** Opaque `rgb(r, g, b)` as `#rrggbb`: a third the length, and the form a
 *  developer greps their stylesheet for. Alpha colours stay as they are. */
const value = (s: string) =>
  trim(
    s.replace(/rgb\((\d+), (\d+), (\d+)\)/g, (_, r: string, g: string, b: string) =>
      [r, g, b].reduce((hex, c) => hex + Number(c).toString(16).padStart(2, '0'), '#'),
    ),
  );

const direction = (dx: number, dy: number) =>
  dx === 0
    ? `${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px`
    : dy === 0
      ? `${dx > 0 ? 'right' : 'left'} ${Math.abs(dx)}px`
      : `${signed(dx)},${signed(dy)}px`;

const extent = (dw: number, dh: number) =>
  dw === 0
    ? `height ${signed(dh)}px`
    : dh === 0
      ? `width ${signed(dw)}px`
      : `${signed(dw)}×${signed(dh)}px`;
