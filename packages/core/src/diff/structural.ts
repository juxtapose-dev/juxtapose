// Structural diff → tier-0 verdict. Pure, no browser, no I/O.
//
// Composition: match → facts → shifts → coverage → classify → summary, then a
// signature over the abstracted facts. Every list is sorted by a documented
// key and the result is built as one literal, so the same inputs always
// serialize to the same bytes (the CLI promises that in its JSON contract).

import { createHash } from 'node:crypto';
import type { DiffOutput } from './diff.js';
import type { Delta, StructureSnapshot, StructuralVerdict } from '../types.js';
import { classify, computeFlags, type ClassifyContext } from './structural/classify.js';
import { computeCoverage } from './structural/coverage.js';
import { compareCodeUnits, computeFacts, type Fact } from './structural/deltas.js';
import { matchElements } from './structural/match.js';
import { synthesizeShifts } from './structural/shift.js';
import { buildSummary } from './structural/summary.js';

export interface StructuralDiffInput {
  baseline?: StructureSnapshot;
  current?: StructureSnapshot;
  /** The two encoded images are byte-identical (equal hashes). Only this
   *  makes a verdict `identical`: a pixel diff with 0 mismatches can still
   *  hide a real change below its tolerance. */
  imagesIdentical: boolean;
  pixels: Pick<DiffOutput, 'changedRegions' | 'dimensionMismatch'>;
  /** The exact tier-3 command; core does not know how the CLI is spelled. */
  escalate: { command: string };
}

export const MAX_DELTAS = 20;

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
  const facts: Fact[] = comparable
    ? synthesizeShifts(
        computeFacts(baseline, current, matchElements(baseline, current)).filter(
          (f) =>
            !(f.delta.kind === 'removed' && current.truncated) &&
            !(f.delta.kind === 'added' && baseline.truncated),
        ),
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
      subThreshold:
        !imagesIdentical &&
        !pixels.dimensionMismatch &&
        pixels.changedRegions.length === 0,
    },
  };
  const { classification, styleTags } = classify(ctx);
  const flags = computeFlags(ctx);
  const deltas: Delta[] = facts.slice(0, MAX_DELTAS).map((f) => f.delta);

  return {
    schema: 'juxtapose.verdict/v1',
    classification,
    styleTags,
    summary: buildSummary({
      classification,
      styleTags,
      deltas,
      deltaCount: facts.length,
      regionCount: pixels.changedRegions.length,
      unexplainedRegions: cov.unexplainedRegions,
      flags,
      imagesIdentical,
      baseline,
      current,
    }),
    deltas,
    deltaCount: facts.length,
    coverage: cov.coverage,
    explained: cov.explained,
    unexplainedRegions: cov.unexplainedRegions,
    flags,
    signature: signature(facts),
    escalate: { command: input.escalate.command },
  };
}

/** sha256 of the facts with each element reduced to role|tag and the values
 *  kept: "every button background #2563eb→#1d4ed8" hashes the same on any
 *  page that made that change. Sorted (by code unit) so order of discovery
 *  cannot leak in. */
function signature(facts: Fact[]): string {
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
  return createHash('sha256').update(items.join('\n')).digest('hex');
}
