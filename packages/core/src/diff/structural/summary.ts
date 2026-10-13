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
const LEAD_ITEMS = 3;
/** Changes listed in one element's clause; the rest join "(+N more)". */
const CLAUSE_CHANGES = 3;
const MAX_VALUE = 40;

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

type ContentDelta = Extract<Delta, { kind: 'text' | 'style' | 'attr' }>;

/** `prop from→to`, without the element. */
function change(d: ContentDelta): string {
  if (d.kind === 'text') return `text "${trim(d.from)}"→"${trim(d.to)}"`;
  return `${changedName(d)} ${value(d.from)}→${value(d.to)}`;
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
  baseline?: StructureSnapshot;
  current?: StructureSnapshot;
}

export function buildSummary(a: SummaryArgs): string {
  const head =
    a.styleTags.length > 0
      ? `${a.classification} (${a.styleTags.join(', ')})`
      : a.classification;
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
      subThreshold
        ? 'Pixel diff below tolerance'
        : `${a.regionCount} changed region${a.regionCount === 1 ? '' : 's'}`,
    );
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
      subThreshold
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
function lead(head: string, a: SummaryArgs, tail: string[]): string {
  const budget = MAX_SUMMARY - tail.reduce((n, t) => n + t.length + 2, 0) - 1;
  const render = (texts: string[], more: number) =>
    `${head}: ${texts.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
  const shown: string[] = [];
  let used = 0;
  for (const item of leadItems(a.deltas).slice(0, LEAD_ITEMS)) {
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

/** Causes before consequences; within a rank, fact (document) order. */
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

function leadItems(deltas: Delta[]): LeadItem[] {
  const ranked = deltas
    .map((d, i) => ({ d, i }))
    .sort((x, y) => CAUSE_RANK[x.d.kind] - CAUSE_RANK[y.d.kind] || x.i - y.i)
    .map((x) => x.d);

  // Content changes on one element read as one clause: `el a→b, c→d`.
  const order: Array<string | Delta> = [];
  const byEl = new Map<string, ContentDelta[]>();
  for (const d of ranked) {
    if (d.kind === 'text' || d.kind === 'style' || d.kind === 'attr') {
      const list = byEl.get(d.el);
      if (list) list.push(d);
      else {
        byEl.set(d.el, [d]);
        order.push(d.el);
      }
    } else order.push(d);
  }
  return order.map((x) => {
    if (typeof x !== 'string') return [{ text: describeDelta(x), consumed: 1 }];
    const parts = shorthand(byEl.get(x)!);
    const forms: LeadItem = [];
    for (let k = Math.min(CLAUSE_CHANGES, parts.length); k >= 1; k--) {
      const some = parts.slice(0, k);
      forms.push({
        text: `${x} ${some.map((p) => p.text).join(', ')}`,
        consumed: some.reduce((n, p) => n + p.consumed, 0),
      });
    }
    forms.push({ text: `${x} ${parts[0].name} changed`, consumed: parts[0].consumed });
    return forms;
  });
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
function shorthand(changes: ContentDelta[]): Part[] {
  const style = new Map<string, Extract<Delta, { kind: 'style' }>>();
  for (const c of changes) if (c.kind === 'style') style.set(c.prop, c);
  const collapsed = new Map<string, Part>(); // first longhand seen → clause
  const absorbed = new Set<string>();
  for (const [name, sides] of BOXES) {
    const ds = sides.map((p) => style.get(p));
    if (ds.some((d) => d === undefined)) continue;
    const four = ds as Array<Extract<Delta, { kind: 'style' }>>;
    const first = changes.find((c) => c.kind === 'style' && sides.includes(c.prop));
    if (first?.kind !== 'style') continue;
    collapsed.set(first.prop, {
      name,
      text: `${name} ${value(boxValue(four.map((d) => d.from)))}→${value(boxValue(four.map((d) => d.to)))}`,
      consumed: 4,
    });
    for (const p of sides) absorbed.add(p);
  }
  const out: Part[] = [];
  for (const c of changes) {
    const box = c.kind === 'style' ? collapsed.get(c.prop) : undefined;
    if (box) out.push(box);
    else if (c.kind !== 'style' || !absorbed.has(c.prop))
      out.push({ name: changedName(c), text: change(c), consumed: 1 });
  }
  return out;
}

/** CSS shorthand value compression: `a a a a` → `a`, `a b a b` → `a b`,
 *  `a b c b` → `a b c`. */
function boxValue([t, r, b, l]: string[]): string {
  if (r === l) {
    if (t === b) return t === r ? t : `${t} ${r}`;
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
const trim = (s: string) => clip(s, MAX_VALUE);

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
