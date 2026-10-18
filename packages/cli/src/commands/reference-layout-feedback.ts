import type { ReferenceResult } from './reference.js';
import type { ReferenceLayoutDetail } from './reference-layout.js';

export interface FocusedLayoutFeedback {
  schema: 'juxtapose.target-layout-focus/v1';
  runId: string;
  name: string;
  capture: string;
  status: string;
  meaning: string;
  issue?: string;
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
  const base = {
    schema: 'juxtapose.target-layout-focus/v1' as const,
    runId: result.runId,
    name: state.name,
    capture: state.storyId,
    status: state.status,
    ...('error' in state
      ? { issue: state.error.slice(0, 240) }
      : 'reason' in state && state.reason
        ? { issue: state.reason.slice(0, 240) }
        : {}),
    meaning:
      'Target/current painted-region geometry; current element identities from DOM. Not CSS causes; other states still require verification.',
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
  return bounded(output);
}

function bounded(response: FocusedLayoutFeedback): FocusedLayoutFeedback {
  if (Buffer.byteLength(JSON.stringify(response)) > MAX_BYTES)
    throw new Error(
      'Focused layout metadata exceeds response budget; use detail=json for the full ledger',
    );
  return response;
}
