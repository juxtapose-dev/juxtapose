// Turn a failing story into a prompt an agent can act on.
//
// The central bet, inherited from the original tool and worth restating:
// send STRUCTURED DATA, not screenshots. `mismatchPercent: 3.72` and a box at
// (412, 88) are exact; an LLM's spatial reasoning over a PNG is probabilistic
// and costs 10-50x the tokens. Images are listed last, as a fallback.
//
// Pure function. No I/O, no clipboard — string in, string out, so it is
// trivially testable and callable from both the CLI and a server.

import type {
  Cause,
  ChangedRegion,
  DiffStatus,
  StructuralVerdict,
  Viewport,
} from '../types.js';
import { describeDeltas } from '../diff/structural/summary.js';
import { shellQuote } from '../shell-quote.js';

export interface HandoffPayload {
  storyId: string;
  storyTitle: string;
  status: DiffStatus;
  mismatchPercent: number;
  mismatchPixels: number;
  changedRegions: ChangedRegion[];
  viewport: Viewport;
  /** Absolute path to the story's source file, when known. */
  componentPath: string;
  /** Absolute path to the machine-readable sidecar for this diff. */
  diffDataPath?: string;
  /** Tier-0 verdict from the run, when the capture had structure. */
  structural?: StructuralVerdict;
  /** `jux diff <baseline.webp> <current.webp> --crops`, when both files exist. */
  cropsCommand?: string;
  images: {
    baseline?: string;
    current?: string;
    diff?: string;
  };
  /** So a session running in the wrong repo can detect the mismatch. */
  projectRoot: string;
  /** Set when the capture is a variant: its story, name and what it sets. */
  variant?: { baseStoryId: string; name: string; params: Record<string, unknown> };
}

/** The handoff's variant field from a run result; undefined for a default
 *  capture. */
export function handoffVariant(r: {
  baseStoryId?: string;
  variant?: string;
  variantParams?: object;
}): HandoffPayload['variant'] {
  return r.baseStoryId !== undefined && r.variant !== undefined
    ? {
        baseStoryId: r.baseStoryId,
        name: r.variant,
        params: { ...(r.variantParams ?? {}) },
      }
    : undefined;
}

/** "the `dark` variant of `card--default`, captured with colorScheme dark and
 *  viewport 375×812": the conditions an agent is fixing under. */
export function describeVariant(v: NonNullable<HandoffPayload['variant']>): string {
  const settings = Object.entries(v.params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, val]) => {
      if (
        k === 'viewport' &&
        typeof val === 'object' &&
        val !== null &&
        'width' in val &&
        'height' in val
      )
        return `viewport ${String(val.width)}×${String(val.height)}`;
      return `${k} ${typeof val === 'string' ? val : JSON.stringify(val)}`;
    });
  const head = `the \`${v.name}\` variant of \`${v.baseStoryId}\``;
  return settings.length > 0
    ? `${head}, captured with ${settings.join(', ')}`
    : `${head}, with no settings of its own`;
}

export function buildHandoffPrompt(p: HandoffPayload): string {
  const lines: string[] = [];

  lines.push(`# Visual change: ${p.storyTitle}`);
  lines.push('');
  lines.push(`Story \`${p.storyId}\` is **${p.status}**.`);
  if (p.variant) {
    lines.push(
      `This capture is ${describeVariant(p.variant)}. Reproduce under those conditions; the story's default capture is a separate baseline.`,
    );
  }
  lines.push('');

  if (p.status === 'new') {
    lines.push(
      'This story has no baseline yet — nothing to compare against. Decide whether',
      'the rendered output is correct, then either approve it to establish the',
      'baseline or fix the component first.',
      '',
      ...actions(p, { approveVerb: 'establish this as the baseline' }),
    );
    return lines.join('\n');
  }

  if (p.status === 'stale') {
    lines.push(
      'The baseline for this story was approved on a commit that is not an ancestor',
      'of HEAD — most likely a branch that never merged. The pixels may well match;',
      'the provenance is what is in question.',
      '',
      'Re-run the capture first. If it then passes, re-approve to re-anchor the',
      'baseline to the current history.',
      '',
      ...actions(p, { approveVerb: 're-anchor the baseline' }),
    );
    return lines.join('\n');
  }

  if (p.diffDataPath) {
    lines.push(`Read \`${p.diffDataPath}\` for the full machine-readable diff.`, '');
  }

  const v = p.structural;
  // Missing data is not a verdict: with no snapshot on one side and nothing
  // to list, a structure section would be empty and misleading.
  const missing =
    v && v.deltas.length === 0
      ? v.flags.includes('no-baseline-structure')
        ? 'baseline'
        : v.flags.includes('no-current-structure')
          ? 'current'
          : undefined
      : undefined;
  if (v?.cause) lines.push('## Why', '', describeCause(v.cause), '');
  if (v && missing) {
    lines.push(
      missing === 'baseline'
        ? 'No structure snapshot for the baseline (approved before juxtapose recorded structure). Re-approve after this change to get structural diffs next time.'
        : 'No structure snapshot for the current capture (structure capture failed or was unavailable). Re-run the capture to get structural diffs.',
      '',
    );
  } else if (v) {
    lines.push('## What changed (structure)');
    lines.push('');
    lines.push(v.summary);
    lines.push('');
    if (v.deltas.length > 0) {
      lines.push(...describeDeltas(v.deltas, v.deltaCount));
      if (v.deltaCount > v.deltas.length) {
        lines.push(
          `  …and ${v.deltaCount - v.deltas.length} more (see the diff data file)`,
        );
      }
      lines.push('');
      lines.push(
        'Check these deltas against the change you intended. If they are all intended,',
        `the change is expected: approve it (\`jux approve --story ${shellQuote(p.storyId)}\`). If any`,
        'delta is one you did not intend, fix that before approving.',
      );
    }
    if (v.flags.length > 0) {
      lines.push('', `Flags: ${v.flags.join(', ')}`);
    }
    if (v.explained !== 'full') {
      lines.push(
        '',
        'Part of the pixel change has no matching DOM or style delta (canvas, images, or',
        'rendering). Look at the diff image for those regions.',
      );
    }
    lines.push('');
  }

  lines.push(v && !missing ? '## Pixels' : '## What changed');
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        storyId: p.storyId,
        mismatchPercent: round(p.mismatchPercent),
        mismatchPixels: p.mismatchPixels,
        viewport: p.viewport,
        regionCount: p.changedRegions.length,
      },
      null,
      2,
    ),
  );
  lines.push('```');
  lines.push('');

  if (p.changedRegions.length > 0) {
    lines.push('## Where it changed');
    lines.push('');
    for (const r of p.changedRegions.slice(0, MAX_REGIONS)) {
      lines.push(`- ${describeRegion(r, p.viewport)}`);
    }
    if (p.changedRegions.length > MAX_REGIONS) {
      lines.push(
        `- …and ${p.changedRegions.length - MAX_REGIONS} more (see the diff data file)`,
      );
    }
    lines.push('');
  }

  lines.push('## Assessment');
  lines.push('');
  lines.push(magnitudeHint(p.mismatchPercent, p.structural?.deltaCount ?? 0));
  lines.push('');

  lines.push(...actions(p, { approveVerb: 'accept the new rendering' }));

  if (p.cropsCommand || p.images.baseline || p.images.current || p.images.diff) {
    lines.push('', '## If still unsure', '');
    if (p.cropsCommand) {
      lines.push(
        `Side-by-side crops of each changed region, unexplained first — run \`${p.cropsCommand}\` and open the files it lists.`,
        '',
      );
    }
    lines.push('Full images, last resort:');
    if (p.images.baseline) lines.push(`- baseline: \`${p.images.baseline}\``);
    if (p.images.current) lines.push(`- current: \`${p.images.current}\``);
    if (p.images.diff) lines.push(`- diff overlay: \`${p.images.diff}\``);
  }

  lines.push('');
  lines.push('---');
  lines.push(
    `Generated for \`${p.projectRoot}\`. If your session is rooted elsewhere, stop — this prompt is for a different repository.`,
  );

  return lines.join('\n');
}

const MAX_REGIONS = 12;

function actions(p: HandoffPayload, opts: { approveVerb: string }): string[] {
  const out = ['## What to do', ''];
  // A partial trace names the changed files it could see; the one that
  // changed the pixels may be one it could not. Pointing the agent at the
  // listed file sent it to the story's label edit for a bundled token change.
  if (p.structural?.cause?.partial) {
    out.push(
      'The files under "Why" changed and are imported, but are not necessarily the cause: other imports could not be traced. Check every file changed since the base, not only those.',
      '',
    );
  }

  if (p.componentPath) {
    out.push(
      `1. Inspect the component: \`${p.componentPath}\``,
      `2. Check recent history: \`git log -p -- ${p.componentPath}\``,
      '3. Decide: intentional change, or regression?',
    );
  } else {
    out.push(
      '1. Locate the component behind this story.',
      '2. Check its recent history for an explanation.',
      '3. Decide: intentional change, or regression?',
    );
  }

  out.push(
    '',
    `- **Intentional** → \`jux approve --story ${shellQuote(p.storyId)}\` to ${opts.approveVerb}.`,
    '- **Regression** → propose a fix. Do not apply it without confirmation.',
  );
  return out;
}

/**
 * Describe a region in language a model reasons about well.
 *
 * Raw coordinates are precise but hard to reason over; "top-left, 2.3% of the
 * viewport" carries the spatial meaning that actually drives the judgement.
 * Both are given.
 */
export function describeRegion(r: ChangedRegion, viewport: Viewport): string {
  const areaPct = ((r.width * r.height) / (viewport.width * viewport.height)) * 100;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const vertical =
    cy < viewport.height / 3
      ? 'top'
      : cy > (viewport.height * 2) / 3
        ? 'bottom'
        : 'middle';
  const horizontal =
    cx < viewport.width / 3 ? 'left' : cx > (viewport.width * 2) / 3 ? 'right' : 'center';
  return `(${r.x}, ${r.y}) ${r.width}×${r.height}px — ${vertical}-${horizontal}, ${round(areaPct)}% of viewport`;
}

/** The one wording of a cause, shared by the handoff and the CLI's review
 *  list (which skips `unknown`). One or two sentences, no heading. */
export function describeCause(c: Cause): string {
  const away = (d: number) =>
    d === 0 ? 'the story file itself' : `${d} import${d === 1 ? '' : 's'} away`;
  switch (c.kind) {
    case 'in-closure':
      return `Changed files this story imports, nearest first: ${c.files
        .map((f) => `\`${f.path}\` (${away(f.distance)})`)
        .join(', ')}${c.partial ? '; other imports could not be traced' : ''}.`;
    case 'config':
      return `A change that reaches every story: ${c.files.map((f) => `\`${f.path}\``).join(', ')}. Expect other stories to fail the same way; the run's \`groups\` lists which.`;
    case 'none-in-closure':
      return "No changed file appears in this story's traced imports. The cause is likely outside your diff: a dependency, an asset, the environment, or render drift.";
    case 'unknown':
      return "Cause unknown: this build doesn't expose every changed file's place in the story's imports, so nothing can be inferred from it.";
  }
}

/**
 * Calibrate the agent's suspicion to the size of the change.
 *
 * Without this, agents treat a 0.02% antialiasing shift and a 40% layout
 * collapse as equally alarming.
 */
function magnitudeHint(pct: number, deltaCount: number): string {
  if (pct < 0.1) {
    // A sub-threshold colour change marks no pixels at all; calling it
    // antialiasing noise beside a real delta argued with the section above.
    if (deltaCount > 0)
      return `Pixels are below tolerance, but structure records ${deltaCount} delta(s); judge those, not the pixel count.`;
    return 'Under 0.1% — consistent with sub-pixel antialiasing noise. Usually safe to approve, but confirm the changed regions are not on meaningful content.';
  }
  if (pct < 1) {
    return 'Under 1% — a small, localized change. Check whether the component or its tokens were recently touched.';
  }
  if (pct < 10) {
    return 'Between 1% and 10% — a substantive visual change. Investigate before approving.';
  }
  return 'Over 10% — a large change, possibly a layout break or a failed render. Investigate carefully; do not approve without understanding the cause.';
}

const round = (n: number) => Math.round(n * 100) / 100;
