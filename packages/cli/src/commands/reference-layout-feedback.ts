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
  layout: ReferenceLayoutDetail | { status: 'unavailable'; reason: string };
}

const MAX_BYTES = 3072;

/** The PNG replay repaired all four states from one 1,776-byte target packet.
 * Keep this explicitly requested: it does not establish default usefulness. */
export function focusedLayoutFeedback(result: ReferenceResult): FocusedLayoutFeedback {
  const state = result.states[0];
  if (!state || result.states.length !== 1)
    throw new Error('focused layout requires exactly one target');
  const layout = 'layout' in state ? state.layout : undefined;
  const region =
    state.status === 'fail' && 'regions' in state ? state.regions[0] : undefined;
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
      'Target/current painted-region geometry; current element identities from DOM. paintedFill is the opaque component RGB, not CSS or whole-element equality; other states still require verification.',
    // Both agents in the contact pilot guessed heading24 before measuring23.
    // Distinguish a resolved edit from a remaining visual question; no forced
    // image/probe step, and no claim that these geometry matches cover all error.
    next:
      state.status === 'pass'
        ? 'This target passes; do not inspect it again to confirm. Verify any remaining required states and behavior.'
        : state.status === 'error' || state.status === 'incompatible'
          ? 'Resolve the reported capture or reference issue first; do not infer a visual edit from incompatible inputs.'
          : 'Use source + measurements to propose an edit, then run affected states once. Treat CSS causes as hypotheses. cropRequest covers cropRegion only; JSON may add saved facts; omissions can remain. It cannot add PNG target DOM or abstained matches. If cropRequest is absent, no saved crop is available.',
  };
  if (!layout || !('matches' in layout))
    return bounded({
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
  for (const match of layout.matches) {
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
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_BYTES) continue;
    matches.push(match);
    confidenceRules[match.confidenceRule] = rule;
    output.layout.omittedMatches--;
  }
  return bounded(appendFocusedPaint(output, layout.paint));
}

function bounded(response: FocusedLayoutFeedback): FocusedLayoutFeedback {
  if (Buffer.byteLength(JSON.stringify(response)) > MAX_BYTES)
    throw new Error(
      'Focused layout metadata exceeds response budget; use detail=json for the full ledger',
    );
  return response;
}
