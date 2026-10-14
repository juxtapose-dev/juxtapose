// Structural diff → tier-0 verdict. Pure, no browser, no I/O.
//
// Composition: match → facts → shifts → unique labels → coverage → classify → summary, then a
// signature over the abstracted facts. Every list is sorted by a documented
// key and the result is built as one literal, so the same inputs always
// serialize to the same bytes (the CLI promises that in its JSON contract).

import { createHash } from 'node:crypto';
import type { DiffOutput } from './diff.js';
import type {
  SettleFlag,
  Cause,
  ChangedRegion,
  Classification,
  Delta,
  StructureSnapshot,
  StructuralVerdict,
} from '../types.js';
import { classify, computeFlags, type ClassifyContext } from './structural/classify.js';
import { computeCoverage } from './structural/coverage.js';
import { disambiguate } from './structural/disambiguate.js';
import { compareCodeUnits, computeFacts, type Fact } from './structural/deltas.js';
import { matchElements } from './structural/match.js';
import { synthesizeShifts } from './structural/shift.js';
import { buildChange, buildSummary } from './structural/summary.js';

export interface StructuralDiffInput {
  baseline?: StructureSnapshot;
  current?: StructureSnapshot;
  /** The two encoded images are byte-identical (equal hashes). Only this
   *  makes a verdict `identical`: a pixel diff with 0 mismatches can still
   *  hide a real change below its tolerance. It implies no changed regions
   *  and no dimension mismatch; if `pixels` contradicts it, the pixel
   *  evidence wins and the verdict is not `identical`. */
  imagesIdentical: boolean;
  pixels: Pick<DiffOutput, 'changedRegions' | 'dimensionMismatch'>;
  /** The exact tier-3 command; core does not know how the CLI is spelled. */
  escalate: { command: string };
  /** From `jux run --since`; `jux diff` has no changed-file set. */
  cause?: Cause;
  /** The current capture's settle flag, if any (`settle-timeout`,
   *  `settle-fallback`): appended to the verdict's flags. */
  settleFlag?: SettleFlag;
}

export const MAX_DELTAS = 20;
/** JSON.stringify(verdict).length never exceeds this. */
export const MAX_VERDICT = 1500;
/** `cause.files` is capped here as well as in the index: the budget is a
 *  guarantee for any input. */
export const MAX_CAUSE_FILES = 5;
/** Longest `cause.files[].path`. The tail is kept: the file name is what a
 *  reader greps for; a 10-deep monorepo prefix is not. */
export const MAX_CAUSE_PATH = 80;

/** The verdict plus every unexplained region: the verdict's own list is the
 *  prefix that fits the budget, and crops must order and label from the whole. */
export function structuralDiffWithCoverage(input: StructuralDiffInput): {
  verdict: StructuralVerdict;
  unexplainedRegions: ChangedRegion[];
  /** One box per element the deltas name, in delta order: the union of its
   *  old and new rects, rounded outward to whole px. What `--crops` shows
   *  when the pixel diff marked nothing (sub-threshold). */
  elementRegions: ChangedRegion[];
} {
  const { baseline, current, pixels, imagesIdentical } = input;
  const comparable =
    baseline !== undefined &&
    current !== undefined &&
    !pixels.dimensionMismatch &&
    baseline.viewport.width === current.viewport.width &&
    baseline.viewport.height === current.viewport.height;

  // With a truncated side, the elements past the cap exist but were not
  // recorded; reporting them as removed would be a lie the summary already
  // tells more honestly as a count.
  // Labels are made unique last, so only elements still named after the
  // shift collapse — the ones a reader will see — are renamed.
  const facts: Fact[] = comparable
    ? disambiguate(
        synthesizeShifts(
          computeFacts(baseline, current, matchElements(baseline, current)).filter(
            (f) =>
              !(f.delta.kind === 'removed' && current.truncated) &&
              !(f.delta.kind === 'added' && baseline.truncated),
          ),
        ),
        baseline,
        current,
      )
    : [];

  const cov = computeCoverage(pixels.changedRegions, facts);
  const ctx: ClassifyContext = {
    baseline,
    current,
    facts,
    explained: cov.explained,
    unexplainedRegions: cov.unexplainedRegions,
    pixels: {
      imagesIdentical,
      dimensionMismatch: pixels.dimensionMismatch,
      hasRegions: cov.regionCount > 0,
      subThreshold:
        !imagesIdentical && !pixels.dimensionMismatch && cov.regionCount === 0,
    },
  };
  const { classification, styleTags } = classify(ctx);
  const flags = computeFlags(ctx);
  // Last, so the flags computeFlags orders keep their positions.
  if (input.settleFlag) flags.push(input.settleFlag);
  const deltas: Delta[] = facts.slice(0, MAX_DELTAS).map((f) => f.delta);
  const summary = buildSummary({
    classification,
    styleTags,
    deltas,
    deltaCount: facts.length,
    regionCount: cov.regionCount,
    unexplainedRegions: cov.unexplainedRegions,
    flags,
    imagesIdentical,
    baseline,
    current,
  });

  // The same clauses with `el` swapped for role|tag, so it reads the same on
  // every page that made the change. Absent when there is nothing to state.
  const change =
    facts.length > 0
      ? buildChange({
          classification,
          styleTags,
          deltas: facts
            .slice(0, MAX_DELTAS)
            .map((f) =>
              f.delta.kind === 'shift'
                ? { ...f.delta, after: f.abstract }
                : { ...f.delta, el: f.abstract },
            ),
          deltaCount: facts.length,
          regionCount: 0,
          unexplainedRegions: [],
          flags,
          imagesIdentical,
        })
      : undefined;

  const sig = signature(classification, facts);
  // Fitted here, not trusted from the caller: the budget is a guarantee for
  // any input, and the index's cap is a courtesy.
  const cause = input.cause && fitCause(input.cause);
  // One literal, one key order: the CLI's byte-stability rests on it.
  const build = (ds: Delta[], regions: ChangedRegion[]): StructuralVerdict => ({
    schema: 'juxtapose.verdict/v1',
    classification,
    styleTags,
    summary,
    ...(change ? { change } : {}),
    deltas: ds,
    deltaCount: facts.length,
    coverage: cov.coverage,
    explained: cov.explained,
    unexplainedRegions: regions,
    flags,
    ...(cause ? { cause } : {}),
    signature: sig,
    escalate: { command: input.escalate.command },
  });

  // The tier-0 budget is a guarantee, not a corpus statistic. Labels (60)
  // and values (200) are capped, but one delta is still 70–400 chars, so 20
  // of them (or a diff with hundreds of regions) would pass 1,500: one button
  // with 10 realistic style changes measured 1,701. Each list keeps the
  // prefix that fits — deltas first, they are the "what" — while deltaCount,
  // coverage and explained still describe the whole. Holds for any input
  // except an escalate command that alone exceeds the budget.
  let room = MAX_VERDICT - JSON.stringify(build([], [])).length;
  const fit = <T>(items: T[]): T[] => {
    const out: T[] = [];
    for (const x of items) {
      const n = JSON.stringify(x).length + (out.length > 0 ? 1 : 0);
      if (n > room) break;
      room -= n;
      out.push(x);
    }
    return out;
  };
  const kept = fit(deltas);
  return {
    verdict: build(kept, fit(cov.unexplainedRegions)),
    unexplainedRegions: cov.unexplainedRegions,
    elementRegions: elementRegions(facts),
  };
}

/** Facts are grouped by element identity (`source`), not label: two
 *  `div.card`s are two boxes. A shift carries its anchor's source but its
 *  run's rects, so it is a box of its own rather than swelling the anchor's.
 *  Zero-area unions carry no pixels and are dropped. */
function elementRegions(facts: Fact[]): ChangedRegion[] {
  const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  for (const f of facts) {
    const key = `${f.delta.kind === 'shift' ? 'shift:' : ''}${f.source.side}:${f.source.index}`;
    for (const r of f.rects) {
      const b = boxes.get(key);
      const x0 = Math.floor(r.x);
      const y0 = Math.floor(r.y);
      const x1 = Math.ceil(r.x + r.w);
      const y1 = Math.ceil(r.y + r.h);
      boxes.set(
        key,
        b
          ? {
              x0: Math.min(b.x0, x0),
              y0: Math.min(b.y0, y0),
              x1: Math.max(b.x1, x1),
              y1: Math.max(b.y1, y1),
            }
          : { x0, y0, x1, y1 },
      );
    }
  }
  return [...boxes.values()]
    .map((b) => ({ x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 }))
    .filter((r) => r.width > 0 && r.height > 0);
}

/** The verdict alone; what every caller but `--crops` wants. */
export function structuralDiff(input: StructuralDiffInput): StructuralVerdict {
  return structuralDiffWithCoverage(input).verdict;
}

/** sha256 of the classification, then the facts with each element reduced
 *  to role|tag and the values kept: "every button background
 *  #2563eb→#1d4ed8" hashes the same on any page that made that change. The
 *  classification leads so that verdicts with no facts — identical, a
 *  canvas redraw, a size change — do not all share one signature. Facts are
 *  sorted (by code unit) so order of discovery cannot leak in. */
function signature(classification: Classification, facts: Fact[]): string {
  const items = facts
    .map((f) => {
      const d = f.delta;
      const rest =
        d.kind === 'text' || d.kind === 'style' || d.kind === 'attr'
          ? [
              d.kind === 'style' ? d.prop : d.kind === 'attr' ? d.attr : 'text',
              d.from,
              d.to,
            ]
          : d.kind === 'moved'
            ? ['moved', d.dx, d.dy]
            : d.kind === 'resized'
              ? ['resized', d.dw, d.dh]
              : d.kind === 'shift'
                ? ['shift', d.dx, d.dy, d.count]
                : [d.kind];
      return JSON.stringify([f.abstract, ...rest]);
    })
    .sort(compareCodeUnits);
  return createHash('sha256')
    .update([classification, ...items].join('\n'))
    .digest('hex');
}

function fitCause(c: Cause): Cause {
  return {
    kind: c.kind,
    files: c.files.slice(0, MAX_CAUSE_FILES).map((f) => ({
      path: clipHead(f.path, MAX_CAUSE_PATH),
      distance: f.distance,
    })),
    ...(c.partial ? { partial: true as const } : {}),
  };
}

/** `…` plus at most the last `max - 1` code units, never starting on the
 *  low half of a surrogate pair: a lone surrogate is not valid UTF-8. */
function clipHead(s: string, max: number): string {
  if (s.length <= max) return s;
  let from = s.length - (max - 1);
  const c = s.charCodeAt(from);
  if (c >= 0xdc00 && c <= 0xdfff) from++;
  return '…' + s.slice(from);
}
