import { describeVisualEquivalence } from '../report/comparison.js';
import { describeRendererRetries } from '../report/renderer-retry.js';
// Turn a failing story into a prompt an agent can act on.
//
// The central bet, inherited from the original tool and worth restating:
// send STRUCTURED DATA, not screenshots. `mismatchPercent: 3.72` and a box at
// (412, 88) are exact; an LLM's spatial reasoning over a PNG is probabilistic
// so measured text comes first. Images are listed last for appearance questions.
//
// Pure function. No I/O, no clipboard — string in, string out, so it is
// trivially testable and callable from both the CLI and a server.

import type {
  Cause,
  ChangedRegion,
  DiffStatus,
  Flake,
  FlakeGroup,
  SettleReport,
  StructuralVerdict,
  Viewport,
} from '../types.js';
import { describeUnstable, NOT_RECHECKED } from '../baseline/approve.js';
import { describeFlake, describeFlakeGroup } from '../flake/describe.js';
import { shellQuote } from '../shell-quote.js';
import {
  BASELINE_IMAGE_UNAVAILABLE,
  SMALL_MISMATCH_PERCENT,
  compareCodeUnits,
  formatPercent,
  isLikelyRenderingNoise,
} from '../report/format.js';

export interface HandoffPayload {
  storyId: string;
  storyTitle: string;
  status: DiffStatus;
  /** The run's stability verdict; see DiffResult.unstable. */
  unstable?: { hashes: string[]; unconfirmed?: string };
  rendererRetry?: import('../types.js').DiffResult['rendererRetry'];
  comparison?: import('../types.js').DiffResult['comparison'];
  /** Why the two captures differed and what to change; see DiffResult.flake. */
  flake?: Flake;
  /** The flake group this story belongs to, when it has one. */
  flakeGroup?: FlakeGroup;
  mismatchPercent: number;
  mismatchPixels: number;
  changedRegions: ChangedRegion[];
  /** The project commits its images on purpose (`git`/`fs` store). */
  imagesCommitted?: boolean;
  /** See DiffResult.baselineImage: no pixel numbers below are real. */
  baselineImage?: 'unavailable';
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
  /** Set when the capture hit its settle cap. */
  settle?: SettleReport;
  /** Set on a skip the project config's `stories` asked for: the globs. */
  skippedBy?: string[];
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
    .sort(([a], [b]) => compareCodeUnits(a, b))
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

/** What a settle flag means for this capture, and the knob for each case. */
function settleSection(s: SettleReport): string[] {
  if (s.status === 'fallback')
    return [
      `**settle-fallback:** ${s.pending.join('; ')}. This capture may show a frame mid-update; re-run it before judging the pixels.`,
    ];
  return [
    `**settle-timeout:** the page still had work at the ${s.timeoutMs} ms settle cap, so this capture may show a frame mid-update. Pending:`,
    ...s.pending.map((p) => `- ${p}`),
    '',
    'Before judging the pixels: work that never finishes (a poll, a stream, analytics) belongs in `settle.network.ignore`; slow but finite work needs a higher `settle.timeout`; a request the story must wait for belongs in `settle.network.require`. Then re-run.',
  ];
}

export function buildHandoffPrompt(p: HandoffPayload): string {
  const lines: string[] = [];

  lines.push(`# Visual change: ${p.storyTitle}`);
  lines.push('');
  lines.push(`Story \`${p.storyId}\` is **${p.status}**.`);
  lines.push(
    'This is saved approved-baseline evidence; design-reference results are separate.',
  );
  if (p.comparison)
    lines.push(
      describeVisualEquivalence([
        {
          storyId: p.storyId,
          status: p.status,
          comparison: p.comparison,
        } as import('../types.js').DiffResult,
      ]),
    );
  if (p.rendererRetry)
    lines.push(
      describeRendererRetries([
        {
          storyId: p.storyId,
          rendererRetry: p.rendererRetry,
        } as import('../types.js').DiffResult,
      ]),
    );
  if (p.unstable?.unconfirmed?.startsWith(NOT_RECHECKED)) {
    lines.push(
      '',
      `**${describeUnstable(p.unstable)}.** Nothing is known about its stability yet; \`jux approve\` confirms it before it becomes a baseline.`,
    );
  } else if (p.unstable) {
    lines.push(
      '',
      `**${describeUnstable(p.unstable)}.** Make the story deterministic first (mask the changing region, a \`stories\` override, or \`freshRenderer\`); approving it would baseline a flake.`,
    );
    if (p.flake) lines.push('', `**${describeFlake(p.flake)}**`);
    if (p.flakeGroup) lines.push('', `Shared fix: ${describeFlakeGroup(p.flakeGroup)}`);
  }
  if (p.variant) {
    lines.push(
      `This capture is ${describeVariant(p.variant)}. Reproduce under those conditions; the story's default capture is a separate baseline.`,
    );
  }
  lines.push('');
  if (p.status === 'skip') {
    const globs = (p.skippedBy ?? []).map((g) => `\`${g}\``).join(', ');
    lines.push(
      p.skippedBy?.length
        ? `It was skipped by the project config: \`stories\` ${globs} set \`skip: true\`, so nothing was captured and there is nothing to fix in the component. To capture it again, remove or narrow that entry (or set \`skip: false\` for this id) in the config.`
        : 'It was skipped, so nothing was captured and there is nothing to compare.',
      '',
    );
    return lines.join('\n');
  }
  // Ahead of every status: a capture taken mid-update can make a new
  // baseline wrong or a failure spurious, so it is read before either.
  if (p.settle) lines.push(...settleSection(p.settle), '');

  if (p.status === 'pass') {
    lines.push(
      'This captured state passes its approved-baseline policy. No baseline repair or approval is needed.',
      'Check only missing required states, design targets or behavior checks; one passing baseline does not complete a design task.',
      'Resolve any capture warnings above before concluding the task is complete.',
    );
    if (!p.structural?.deltaCount && !p.structural?.flags.length) return lines.join('\n');
  }

  if (p.status === 'new') {
    lines.push(
      'This story has no baseline yet — nothing to compare against. Decide whether',
      'the rendered output meets the requested task. Establish a baseline only if',
      'the user explicitly asks for approval; otherwise fix or review as requested.',
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
      'Re-run the capture first. If it then passes, report the stale provenance.',
      'Re-anchor the baseline only if the user explicitly asks for approval.',
      '',
      ...actions(p, { approveVerb: 're-anchor the baseline' }),
    );
    return lines.join('\n');
  }

  if (p.diffDataPath) {
    lines.push(
      `Use the evidence below first. Read \`${p.diffDataPath}\` only for missing saved detail; it cannot recover deltas omitted from the report.`,
      '',
    );
  }

  const imageUnavailable = p.baselineImage === 'unavailable';
  if (imageUnavailable) {
    lines.push(
      `Note: ${BASELINE_IMAGE_UNAVAILABLE}. The hash differs from the approved one, but the approved image is not on this machine, so there is no pixel diff, crops, or diff overlay. Restore the image cache (or run \`jux run\` on the base commit) to get them.`,
      '',
    );
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
        ? 'No structure snapshot for the baseline, so nothing explains these pixels. A later approval requested by the user stores structure for future comparisons.'
        : 'No structure snapshot for the current capture (structure capture failed or was unavailable). Re-run the capture to get structural diffs.',
      '',
    );
  } else if (v) {
    lines.push('## What changed (structure)');
    lines.push('');
    lines.push(`Classification: ${v.classification}.`);
    lines.push(
      'Observed DOM/style differences (geometry does not establish the root cause):',
      '```json',
      JSON.stringify({
        deltas: v.deltas,
        recorded: v.deltas.length,
        total: v.deltaCount,
      }),
      '```',
      `Coverage: ${v.explained}; ${round(v.coverage * 100)}% of changed-region area intersects structural changes. This is spatial coverage, not causal proof.`,
    );
    lines.push('');
    if (v.deltaCount > v.deltas.length) {
      lines.push(
        `Evidence incomplete: ${v.deltaCount - v.deltas.length} additional deltas were omitted by the report size limit. Inspect the source and captures before concluding that all changes are intended.`,
        '',
      );
    }
    if (v.deltas.length > 0) {
      lines.push(
        'Check these deltas against the change you intended. If they are all intended,',
        'the baseline change is expected; this does not establish design-target correctness.',
        'Approval still requires an explicit user request. Fix unintended deltas when a fix was requested.',
      );
    }
    if (v.flags.length > 0) {
      lines.push('', `Flags: ${v.flags.join(', ')}`);
    }
    if (v.explained !== 'full') {
      lines.push(
        '',
        'Part of the pixel change has no matching DOM or style delta (canvas, images, or',
        'rendering). Inspect paired crops for those regions if appearance remains unclear.',
      );
    }
    lines.push('');
  }

  if (!imageUnavailable) {
    lines.push(
      `Pixel summary: ${formatPercent(p.mismatchPercent)} changed (${p.mismatchPixels} pixels) across ${p.changedRegions.length} detected region${p.changedRegions.length === 1 ? '' : 's'} at ${p.viewport.width}×${p.viewport.height}.`,
      '',
    );
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
      lines.push(
        'Largest region boxes first (box area is not the number of changed pixels):',
      );
      const rankedRegions = [...p.changedRegions].sort(
        (a, b) => b.width * b.height - a.width * a.height || a.y - b.y || a.x - b.x,
      );
      for (const r of rankedRegions.slice(0, MAX_REGIONS)) {
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
    lines.push(magnitudeHint(p));
    lines.push('');
  }

  if (p.status !== 'pass')
    lines.push(...actions(p, { approveVerb: 'accept the new rendering' }));

  if (p.cropsCommand || p.images.baseline || p.images.current || p.images.diff) {
    lines.push('', '## If still unsure', '');
    if (p.cropsCommand) {
      lines.push(
        `If text evidence cannot settle the appearance, inspect paired crops even when structural coverage is full. Run \`${p.cropsCommand}\` and open the files it lists.`,
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
      `1. Use the supplied evidence; inspect relevant source as needed: \`${p.componentPath}\``,
      `2. If intent remains unclear, check recent history: \`git log -p -- ${shellQuote(p.componentPath)}\``,
      '3. Decide: intentional change, or regression?',
    );
  } else {
    out.push(
      '1. Use the supplied evidence; locate relevant source only when needed for the requested task.',
      '2. If intent remains unclear, check recent history for an explanation.',
      '3. Decide: intentional change, or regression?',
    );
  }

  out.push(
    '',
    `- **Intentional** → report the review conclusion. Only if the user explicitly asks for approval, use \`jux approve --story ${shellQuote(p.storyId)}\` to ${opts.approveVerb}.`,
    // A project on the repo-backed store commits its images on purpose.
    ...(p.imagesCommitted
      ? []
      : [
          '  After authorized approval, commit `juxtapose.manifest.json` and `juxtapose.structures/`. Never `git add` an image: baseline images stay in the local cache.',
        ]),
    '- **Regression** → if the user requested a fix, apply it within that scope and verify the affected stories and variants. For a review-only request, describe the proposed fix without changing files.',
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
 * Calibrate the agent's suspicion to the evidence, never to the size alone.
 *
 * Pass/fail is a byte-exact hash, so a small mismatch percentage means a small
 * element changed. Font-size, colour, icon and border changes routinely land
 * under 0.1% of a 1280x800 frame, so "small" is never reassurance. Only a
 * structural diff that positively shows nothing changed, plus hairline
 * regions, earns the noise wording.
 */
function magnitudeHint(p: HandoffPayload): string {
  const pct = p.mismatchPercent;
  const deltaCount = p.structural?.deltaCount ?? 0;
  if (pct < SMALL_MISMATCH_PERCENT) {
    // A sub-threshold colour change marks no pixels at all; calling it
    // antialiasing noise beside a real delta argued with the section above.
    if (deltaCount > 0)
      return `Pixels are below tolerance, but structure records ${deltaCount} delta(s); judge those, not the pixel count.`;
    if (isLikelyRenderingNoise(p))
      return 'Likely rendering noise: the structure is identical (no element moved, resized or changed text or style) and the changed regions are thin edge hairlines. Still glance at the crops before approving.';
    const where = p.changedRegions.length
      ? ` in ${p.changedRegions.length} region${p.changedRegions.length === 1 ? '' : 's'} (${p.changedRegions
          .slice(0, 3)
          .map((r) => describeRegion(r, p.viewport))
          .join('; ')}${p.changedRegions.length > 3 ? '; …' : ''})`
      : ' (the diff marked no region)';
    const why = p.structural?.flags.includes('no-baseline-structure')
      ? 'There is no baseline structure to compare, so nothing explains it.'
      : p.structural
        ? 'The structural diff does not show this to be rendering noise.'
        : 'There is no structural diff, so nothing explains it.';
    return `Unexplained: ${formatPercent(pct)} of pixels changed${where}. A small mismatch is not a safe one; a font-size, colour, icon or border change routinely lands here. ${why} Inspect the crops and do not approve without looking.`;
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
