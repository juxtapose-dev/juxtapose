import {
  fitsFocusedEvidence,
  evidenceBytes,
  FOCUSED_MAX_BYTES,
} from './reference-evidence-budget.js';
import type { ReferenceResult } from './reference.js';
import type { ReferenceLayoutDetail } from './reference-layout.js';
import { appendFocusedPaint, type FocusedPaintFeedback } from './reference-paint.js';

export interface FocusedLayoutFeedback {
  schema: 'juxtapose.target-layout-focus/v1';
  runId: string;
  name: string;
  capture: string;
  status: string;
  meaning: string;
  next: string;
  /** Valid reference arguments, only when a saved changed-region ID exists. */
  cropRequest?: { name: string; region: string };
  /** Changed-pixel bounds selected by cropRequest; not a diagnosis of other regions. */
  cropRegion?: { x: number; y: number; width: number; height: number };
  issue?: string;
  paint?: FocusedPaintFeedback;
  /** Co-located pixel observations, never element/color substitutions. */
  colorSamples?: {
    provenance: 'measured-from-pixels';
    basis: string;
    visibleMismatchSamples: number;
    pairs: Array<{
      reference: string;
      current: string;
      samples: number;
    }>;
  };
  omittedColorPairs?: number;
  layout: ReferenceLayoutDetail | { status: 'unavailable'; reason: string };
}

/** The PNG replay repaired all four states from one 1,776-byte target packet.
 * Keep this explicitly requested: it does not establish default usefulness. */
export function focusedLayoutFeedback(result: ReferenceResult): FocusedLayoutFeedback {
  const state = result.states[0];
  if (!state || result.states.length !== 1)
    throw new Error('focused layout requires exactly one target');
  const layout = 'layout' in state ? state.layout : undefined;
  const region =
    state.status === 'fail' && 'regions' in state ? state.regions[0] : undefined;
  const colors = 'visibleColors' in state ? state.visibleColors : undefined;
  const base = {
    schema: 'juxtapose.target-layout-focus/v1' as const,
    runId: result.runId,
    name: state.name,
    capture: state.storyId,
    status: state.status,
    ...(region
      ? {
          cropRequest: { name: state.name, region: region.id },
          cropRegion: {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
          },
        }
      : {}),
    ...('error' in state
      ? { issue: state.error.slice(0, 240) }
      : 'reason' in state && state.reason
        ? { issue: state.reason.slice(0, 240) }
        : {}),
    meaning:
      'Target/current painted-region geometry; current DOM labels are not unique selectors; paths in detail=json. paintedFill is the opaque component RGB, not CSS or whole-element equality; other states still require verification.',
    // Both agents in the contact pilot guessed heading24 before measuring23.
    // Distinguish a resolved edit from a remaining visual question; no forced
    // image/probe step, and no claim that these geometry matches cover all error.
    next:
      state.status === 'pass'
        ? 'This target passes; do not inspect it again to confirm. Verify any remaining required states and behavior.'
        : state.status === 'error' || state.status === 'incompatible'
          ? 'Resolve the reported capture or reference issue first; do not infer a visual edit from incompatible inputs.'
          : 'Use source + measurements to propose an edit, then run affected states once. Treat CSS causes as hypotheses. cropRequest covers cropRegion only; JSON provides all saved matches; other omissions can remain. It cannot add PNG target DOM or abstained matches. If cropRequest is absent, no saved crop is available.',
  };
  // The new directory case requested a 4,984-byte ledger reply for colors after
  // layout. Reuse those observations here; geometry keeps priority under 3KiB.
  const finish = (response: FocusedLayoutFeedback): FocusedLayoutFeedback => {
    if (colors?.pairs.length) {
      const candidate: FocusedLayoutFeedback = {
        ...response,
        colorSamples: {
          provenance: 'measured-from-pixels',
          basis: 'co-located pixels; not element matches or CSS substitutions',
          visibleMismatchSamples: colors.visibleMismatchSamples,
          pairs: colors.pairs.slice(0, 2).map((pair) => ({
            reference: colorHex(pair.reference),
            current: colorHex(pair.current),
            samples: pair.pixels,
          })),
        },
        omittedColorPairs: Math.max(0, colors.pairs.length - 2),
      };
      if (fitsFocusedEvidence(response, candidate))
        return bounded(candidate);
      const omitted = { ...response, omittedColorPairs: colors.pairs.length };
      if (evidenceBytes(omitted) <= FOCUSED_MAX_BYTES)
        return bounded(omitted);
    }
    return bounded(response);
  };
  if (!layout || !('matches' in layout))
    return finish({
      ...base,
      layout: layout ?? { status: 'unavailable', reason: 'no-layout-evidence' },
    });
  const matches: typeof layout.matches = [];
  const confidenceRules: Record<string, string> = {};
  const output = {
    ...base,
    layout: {
      status: layout.status,
      ...('reason' in layout ? { reason: layout.reason } : {}),
      matches,
      confidenceRules,
      abstained: layout.abstained,
      omittedMatches: layout.omittedMatches + layout.matches.length,
    },
  };
  for (const original of layout.matches) {
    // The team trace fetched full JSON for repeated desktop positions after
    // preview paths crowded out paint. Keep labels and provenance here; the
    // full ledger retains paths. A path-only identity must remain intact.
    const { path, ...identity } = original.element;
    const match = {
      ...original,
      element: identity.label || identity.id ? identity : original.element,
    };
    void path;
    const rule = layout.confidenceRules[match.confidenceRule];
    if (typeof rule !== 'string') continue;
    const candidate = {
      ...output,
      layout: {
        ...output.layout,
        matches: [...matches, match],
        confidenceRules: { ...confidenceRules, [match.confidenceRule]: rule },
        omittedMatches: output.layout.omittedMatches - 1,
      },
    };
    if (!fitsFocusedEvidence(output, candidate)) continue;
    matches.push(match);
    confidenceRules[match.confidenceRule] = rule;
    output.layout.omittedMatches--;
  }
  return finish(appendFocusedPaint(output, layout.paint));
}

function colorHex(rgba: [number, number, number, number]): string {
  const values = rgba[3] === 255 ? rgba.slice(0, 3) : rgba;
  return `#${values.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function bounded(response: FocusedLayoutFeedback): FocusedLayoutFeedback {
  if (evidenceBytes(response) > FOCUSED_MAX_BYTES)
    throw new Error(
      'Focused layout metadata exceeds response budget; use detail=json for the full ledger',
    );
  return response;
}
