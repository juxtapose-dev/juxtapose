// Deterministic prose. No model, no adjectives: the classification, the
// changes that caused it, and whether they account for the pixels. Hard cap
// 300 chars.
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
import { label } from './label.js';

export const MAX_SUMMARY = 300;
const LEAD_ITEMS = 3;
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
  const name = d.kind === 'style' ? d.prop : d.attr;
  return `${name} ${value(d.from)}→${value(d.to)}`;
}

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
  } else if (missing) {
    body = `${head}: no ${missing} structure, so nothing explains the pixels; re-snap (or re-approve) with structure capture enabled`;
    tail.unshift(
      subThreshold
        ? 'Pixel diff below tolerance'
        : `${a.regionCount} changed region${a.regionCount === 1 ? '' : 's'}`,
    );
  } else if (a.classification === 'dimension-change' && a.baseline && a.current) {
    body = `${head}: ${size(a.baseline)} → ${size(a.current)}; compare at one viewport`;
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
  return out.length <= MAX_SUMMARY ? out : out.slice(0, MAX_SUMMARY - 1) + '…';
}

/** Up to LEAD_ITEMS clauses, causes first, each fitting the remaining budget
 *  whole — a clause cut mid-value would misstate the change. */
function lead(head: string, a: SummaryArgs, tail: string[]): string {
  const items = leadItems(a.deltas);
  const reserve = tail.reduce((n, t) => n + t.length + 2, 0) + 1;
  const shown: string[] = [];
  let used = 0;
  for (const item of items.slice(0, LEAD_ITEMS)) {
    const more = a.deltaCount - used - item.consumed;
    const candidate = `${head}: ${[...shown, item.text].join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
    if (shown.length > 0 && candidate.length + reserve > MAX_SUMMARY) break;
    shown.push(item.text);
    used += item.consumed;
  }
  const more = a.deltaCount - used;
  return `${head}: ${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

interface LeadItem {
  text: string;
  /** How many deltas this clause states, for the "(+N more)" count. */
  consumed: number;
}

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

  const items: LeadItem[] = [];
  // Content changes on one element read as one clause: `el a→b, c→d`.
  const byEl = new Map<string, LeadItem & { changes: ContentDelta[] }>();
  for (const d of ranked) {
    if (d.kind === 'text' || d.kind === 'style' || d.kind === 'attr') {
      const item = byEl.get(d.el);
      if (item) item.changes.push(d);
      else {
        const fresh = { text: '', consumed: 0, changes: [d] };
        byEl.set(d.el, fresh);
        items.push(fresh);
      }
    } else items.push({ text: describeDelta(d), consumed: 1 });
  }
  for (const [el, item] of byEl) {
    const parts = shorthand(item.changes);
    item.text = `${el} ${parts.join(', ')}`;
    item.consumed = item.changes.length;
  }
  return items.map(({ text, consumed }) => ({ text, consumed }));
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
function shorthand(changes: ContentDelta[]): string[] {
  const style = new Map<string, Extract<Delta, { kind: 'style' }>>();
  for (const c of changes) if (c.kind === 'style') style.set(c.prop, c);
  const collapsed = new Map<string, string>(); // first longhand seen → clause
  const absorbed = new Set<string>();
  for (const [name, sides] of BOXES) {
    const ds = sides.map((p) => style.get(p));
    if (ds.some((d) => d === undefined)) continue;
    const four = ds as Array<Extract<Delta, { kind: 'style' }>>;
    const first = changes.find((c) => c.kind === 'style' && sides.includes(c.prop));
    if (first?.kind !== 'style') continue;
    collapsed.set(
      first.prop,
      `${name} ${value(boxValue(four.map((d) => d.from)))}→${value(boxValue(four.map((d) => d.to)))}`,
    );
    for (const p of sides) absorbed.add(p);
  }
  const out: string[] = [];
  for (const c of changes) {
    if (c.kind !== 'style') out.push(change(c));
    else if (collapsed.has(c.prop)) out.push(collapsed.get(c.prop)!);
    else if (!absorbed.has(c.prop)) out.push(change(c));
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
  if (u === 0)
    return n === 1
      ? 'Structure explains the changed region'
      : `Structure explains all ${n} changed regions`;
  if (u === n)
    return n === 1
      ? 'Nothing in the structure explains the changed region'
      : `Nothing in the structure explains the ${n} changed regions`;
  return `${u} of ${n} changed regions unexplained`;
}

const size = (s: StructureSnapshot) => `${s.viewport.width}×${s.viewport.height}`;
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const trim = (s: string) => (s.length > MAX_VALUE ? s.slice(0, MAX_VALUE - 1) + '…' : s);

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
