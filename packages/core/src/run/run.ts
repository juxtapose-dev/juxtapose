// Orchestrate a run: enumerate → select → capture → judge → report.
//
// The ordering reflects the cost model. Hashing is cheap and decides pass/fail,
// so it runs for every story. Decoding and diffing are expensive and explain
// nothing about a passing story, so they run only for stories that already
// failed. On a green run this function never decodes a single image.

import type { Browser } from '../browser/browser.js';
import { captureEnv } from '../capture/env.js';
import type { Platform } from '../platform.js';
import type {
  BaselineStore,
  DiffResult,
  DiffStatus,
  ProjectConfig,
  RunReport,
  Snapshot,
  StoryManifest,
  StructuralVerdict,
  StructureSnapshot,
  Viewport,
} from '../types.js';
import { capturePool } from '../capture/pool.js';
import { resolveStatus, toDiffStatus, type AncestryCheck } from '../baseline/status.js';
import { decodeStructure } from '../capture/structure.js';
import { structuralDiff } from '../diff/structural.js';
import { compareCodeUnits } from '../diff/structural/deltas.js';
import { computeGroups } from './groups.js';
import {
  diffImages,
  type DiffOutput,
  resolveThreshold,
  resolveMinDiffPercent,
} from '../diff/diff.js';
import { phases, type Phases } from './phases.js';
import type { CauseIndex } from '../analysis/cause.js';
import { shellQuote } from '../shell-quote.js';
import type { SettleLayer } from '../capture/settle-options.js';

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };

export interface RunOptions {
  browser: Browser;
  platform: Platform;
  store: BaselineStore;
  baseUrl: string;
  stories: StoryManifest[];
  /** Total story count before affected-filtering, for the report. */
  totalCount: number;
  config?: ProjectConfig;
  ancestry?: AncestryCheck;
  runId: string;
  branch: string;
  commitSha: string;
  /** Receives each story's images so the caller decides where they land. */
  onArtifact?: (artifact: RunArtifact) => Promise<void>;
  onProgress?: (done: number, total: number, storyId: string) => void;
  /** Non-fatal capture notices; the caller decides where they go. */
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
  /** Collects per-phase wall time. Pass one to fold in phases the caller timed
   *  itself (enumerate, affected, launch); omit and one is made internally. */
  phases?: Phases;
  /** From `jux run --since`: consulted only for a story that failed. */
  cause?: CauseIndex;
  /** Per-call settle options (CLI flags, MCP arguments), layered over every
   *  story's own. The project's come from `config`. */
  settle?: SettleLayer;
}

export interface RunArtifact {
  storyId: string;
  status: DiffStatus;
  current: Buffer;
  diff?: Buffer;
  structure?: StructureSnapshot;
}

export async function runCapture(opts: RunOptions): Promise<RunReport> {
  const startedAt = new Date();
  const started = Date.now();
  const viewport = opts.config?.viewport ?? DEFAULT_VIEWPORT;
  const p = opts.phases ?? phases();
  const manifest = await p.time('baselines', () => opts.store.readManifest());
  const results: DiffResult[] = [];

  const pool = capturePool(opts.stories, {
    browser: opts.browser,
    platform: opts.platform,
    baseUrl: opts.baseUrl,
    concurrency: opts.config?.concurrency,
    warmSwitch: opts.config?.warmSwitch,
    viewport,
    onProgress: opts.onProgress,
    ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
    settleLayers: {
      project: {
        ...(opts.config?.settle ? { settle: opts.config.settle } : {}),
        ...(opts.config?.waitForSelector !== undefined
          ? { waitForSelector: opts.config.waitForSelector }
          : {}),
        ...(opts.config?.delay !== undefined ? { delay: opts.config.delay } : {}),
      },
      ...(opts.settle ? { call: opts.settle } : {}),
    },
    signal: opts.signal,
  });

  // Capture is measured as the whole streamed loop rather than per story: the
  // pool runs `concurrency` pages at once, so summing per-story durations would
  // report several times the wall-clock actually spent.
  const captureStarted = Date.now();

  for await (const outcome of pool) {
    if (outcome.skipped) {
      results.push({
        storyId: outcome.story.storyId,
        ...variantOf(outcome.story),
        status: 'skip',
        mismatchPixels: 0,
        mismatchPercent: 0,
        changedRegions: [],
        durationMs: 0,
      });
      continue;
    }

    if (outcome.error || !outcome.snapshot) {
      results.push({
        storyId: outcome.story.storyId,
        ...variantOf(outcome.story),
        status: 'fail',
        mismatchPixels: 0,
        mismatchPercent: 0,
        changedRegions: [],
        error: outcome.error?.message ?? 'capture produced no snapshot',
        durationMs: 0,
      });
      continue;
    }

    results.push(await judge(outcome.snapshot, outcome.story, manifest, opts, p));
  }

  // Diffing and cause tracing happen inside the loop; subtract both to
  // leave capture alone.
  p.add(
    'capture',
    Date.now() - captureStarted - (p.timings.diff ?? 0) - (p.timings.cause ?? 0),
  );

  const summary = tally(results);
  // Code-unit order: the report is byte-stable across machines, and
  // localeCompare is not.
  results.sort((a, b) => compareCodeUnits(a.storyId, b.storyId));
  const groups = computeGroups(results);

  return {
    runId: opts.runId,
    branch: opts.branch,
    commitSha: opts.commitSha,
    // Carried on the report because `approve` has no browser of its own — it
    // reads captured images off disk, so this is the only path by which the
    // fingerprint reaches a baseline entry.
    env: captureEnv(opts.browser),
    capturedCount: opts.stories.length,
    totalCount: opts.totalCount,
    results,
    summary,
    ...(groups.length > 0 ? { groups } : {}),
    durationMs: Date.now() - started,
    startedAt: startedAt.toISOString(),
  };
}

/** Decide one story's fate. Cheap path first. */
async function judge(
  snapshot: Snapshot,
  story: StoryManifest,
  manifest: Awaited<ReturnType<BaselineStore['readManifest']>>,
  opts: RunOptions,
  p: Phases,
): Promise<DiffResult> {
  const baselineStatus = resolveStatus(
    story.storyId,
    snapshot.image,
    manifest,
    opts.ancestry,
  );
  const status = toDiffStatus(baselineStatus);

  const base: DiffResult = {
    storyId: story.storyId,
    ...variantOf(story),
    status,
    mismatchPixels: 0,
    mismatchPercent: 0,
    changedRegions: [],
    // The effective viewport, including any per-story override. Recording it
    // with the regions means nobody downstream has to re-enumerate stories to
    // find out what the coordinates are relative to.
    viewport: snapshot.viewport,
    // Never silent: a capture taken at the settle cap says so on every
    // status, a pass included, with what was still pending.
    ...(snapshot.settle
      ? { flags: ['settle-timeout' as const], settle: snapshot.settle }
      : {}),
    durationMs: snapshot.durationMs,
  };

  // pass / new / stale need no pixel work: there is either nothing to explain
  // or nothing to compare against.
  if (status !== 'fail') {
    await opts.onArtifact?.({
      storyId: story.storyId,
      status,
      current: snapshot.image,
      structure: snapshot.structure,
    });
    return base;
  }

  const baseline = await opts.store.get(story.storyId);
  if (!baseline) {
    // The manifest claimed a baseline the store can't produce.
    await opts.onArtifact?.({
      storyId: story.storyId,
      status,
      current: snapshot.image,
      structure: snapshot.structure,
    });
    return { ...base, error: 'baseline missing from store' };
  }

  // Counted as well as timed: under a byte-exact hash the number of diffs is
  // how broken the run was, and it is the figure that explains a slow one.
  p.count('diff');
  const diff = await p.time('diff', () =>
    diffImages(baseline, snapshot.image, {
      threshold: resolveThreshold(story.params, opts.config),
      minDiffPercent: resolveMinDiffPercent(story.params, opts.config),
    }),
  );

  await opts.onArtifact?.({
    storyId: story.storyId,
    status,
    current: snapshot.image,
    diff: diff.diffImage,
    structure: snapshot.structure,
  });

  // Structure explains the failure after the pixels have decided it. The
  // baseline sidecar is read only here, so a green run never touches one. A
  // manifest hash is not a file: read the store, and treat anything
  // unreadable as absent. This code runs only on a hash mismatch.
  const structural = await tryStructural(opts, story, snapshot, diff, p);

  return {
    ...base,
    mismatchPixels: diff.mismatchPixels,
    mismatchPercent: diff.mismatchPercent,
    changedRegions: diff.changedRegions,
    error: diff.dimensionMismatch ? 'viewport size changed since baseline' : undefined,
    ...(structural ? { structural } : {}),
  };
}

/** A sidecar that is absent or unreadable is simply no baseline structure. */
async function readBaselineStructure(
  store: BaselineStore,
  storyId: string,
): Promise<StructureSnapshot | undefined> {
  try {
    const gz = store.getStructure ? await store.getStructure(storyId) : null;
    return gz ? decodeStructure(gz) : undefined;
  } catch {
    return undefined;
  }
}

/** Structure explains a failure, never decides one, so nothing in here may
 *  fail the story: a missing, corrupt or malformed sidecar, a cause index
 *  that throws, or a bug in the diff, yields no verdict (or one without a
 *  cause) and the pixel result stands. */
async function tryStructural(
  opts: RunOptions,
  story: StoryManifest,
  snapshot: Snapshot,
  pixels: Pick<DiffOutput, 'changedRegions' | 'dimensionMismatch'>,
  p: Phases,
): Promise<StructuralVerdict | undefined> {
  if (!snapshot.structure) return undefined;
  let cause: Awaited<ReturnType<CauseIndex['causeFor']>> | undefined;
  if (opts.cause) {
    try {
      cause = await p.time('cause', () => opts.cause!.causeFor(story.componentPath));
    } catch {
      cause = undefined;
    }
  }
  try {
    return structuralDiff({
      baseline: await readBaselineStructure(opts.store, story.storyId),
      current: snapshot.structure,
      imagesIdentical: false,
      pixels,
      escalate: { command: `jux handoff ${shellQuote(story.storyId)}` },
      ...(cause ? { cause } : {}),
      ...(snapshot.settle ? { settleTimeout: true } : {}),
    });
  } catch {
    return undefined;
  }
}

/** The grouping fields a report needs, present only on a variant capture so
 *  a default capture's result serializes exactly as it did before variants. */
function variantOf(
  story: StoryManifest,
): Pick<DiffResult, 'baseStoryId' | 'variant' | 'variantParams'> {
  return story.variant !== undefined && story.baseStoryId !== undefined
    ? {
        baseStoryId: story.baseStoryId,
        variant: story.variant,
        variantParams: story.variantParams ?? {},
      }
    : {};
}

function tally(results: DiffResult[]): Record<DiffStatus, number> {
  const summary: Record<DiffStatus, number> = {
    pass: 0,
    fail: 0,
    new: 0,
    stale: 0,
    skip: 0,
  };
  for (const r of results) summary[r.status]++;
  return summary;
}
