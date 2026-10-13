// Structural diff → tier-0 verdict. Pure, no browser, no I/O.
//
// Composition: match → facts → shifts → unique labels → coverage → classify → summary, then a
// signature over the abstracted facts. Every list is sorted by a documented
// key and the result is built as one literal, so the same inputs always
// serialize to the same bytes (the CLI promises that in its JSON contract).

import { createHash } from 'node:crypto';
import type { DiffOutput } from './diff.js';
import type {
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
import { buildSummary } from './structural/summary.js';

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
}

export const MAX_DELTAS = 20;
/** JSON.stringify(verdict).length never exceeds this. */
export const MAX_VERDICT = 1500;

export function structuralDiff(input: StructuralDiffInput): StructuralVerdict {
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

  const sig = signature(classification, facts);
  // One literal, one key order: the CLI's byte-stability rests on it.
  const build = (ds: Delta[], regions: ChangedRegion[]): StructuralVerdict => ({
    schema: 'juxtapose.verdict/v1',
    classification,
    styleTags,
    summary,
    deltas: ds,
    deltaCount: facts.length,
    coverage: cov.coverage,
    explained: cov.explained,
    unexplainedRegions: regions,
    flags,
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
  return build(kept, fit(cov.unexplainedRegions));
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
