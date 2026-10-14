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
import {
  hashImage,
  resolveStatus,
  toDiffStatus,
  type AncestryCheck,
} from '../baseline/status.js';
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
import { captureFlags, settleFlag, type SettleLayer } from '../capture/settle-options.js';

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
  /** Progress of the second-capture pass over new and failing stories. */
  onRecheck?: (done: number, total: number, storyId: string) => void;
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
  const firstPassWarnings = new Set<string>();
  const toConfirm = new Map<string, DiffResult>();

  const poolOptions = (onProgress: RunOptions['onProgress']) => ({
    browser: opts.browser,
    platform: opts.platform,
    baseUrl: opts.baseUrl,
    concurrency: opts.config?.concurrency,
    warmSwitch: opts.config?.warmSwitch,
    ...(opts.config?.freshRenderer !== undefined
      ? { freshRenderer: opts.config.freshRenderer }
      : {}),
    ...(opts.config?.storyTimeout !== undefined
      ? { storyTimeoutMs: opts.config.storyTimeout }
      : {}),
    viewport,
    onProgress,
    ...(opts.onWarning
      ? {
          onWarning: (m: string) => {
            firstPassWarnings.add(m);
            opts.onWarning!(m);
          },
        }
      : {}),
    settleLayers: {
      project: {
        ...(opts.config?.settle ? { settle: opts.config.settle } : {}),
        ...(opts.config?.network ? { network: opts.config.network } : {}),
        ...(opts.config?.waitForSelector !== undefined
          ? { waitForSelector: opts.config.waitForSelector }
          : {}),
        ...(opts.config?.delay !== undefined ? { delay: opts.config.delay } : {}),
      },
      ...(opts.settle ? { call: opts.settle } : {}),
    },
    signal: opts.signal,
  });
  const pool = capturePool(opts.stories, poolOptions(opts.onProgress));

  // Capture is measured as the whole streamed loop rather than per story: the
  // pool runs `concurrency` pages at once, so summing per-story durations would
  // report several times the wall-clock actually spent.
  const captureStarted = Date.now();

  // The pool drops any `skip` capture without a word. One the project config
  // asked for is reported, with the globs, so a skipped story is never a
  // mystery in the run or the handoff.
  for (const story of opts.stories) {
    if (story.params.skip !== true || !story.skippedBy) continue;
    results.push({
      storyId: story.storyId,
      ...variantOf(story),
      status: 'skip',
      skippedBy: story.skippedBy,
      mismatchPixels: 0,
      mismatchPercent: 0,
      changedRegions: [],
      durationMs: 0,
    });
  }

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
        // The time the story really took: a hung one is the slowest story.
        durationMs: outcome.durationMs,
      });
      continue;
    }

    const result = await judge(outcome.snapshot, outcome.story, manifest, opts, p);
    results.push(result);
    if ((result.status === 'new' || result.status === 'fail') && result.hash) {
      toConfirm.set(result.storyId, result);
    }
  }

  // Approval turns a capture into a baseline, so a flaky one is only caught
  // for free here, while the browser is open. Only stories that could be
  // approved are captured again (new and changed ones); a passing story
  // already matched a recorded hash and costs nothing extra.
  //
  // Fail closed: a story is stable only if its second capture produced an
  // image with the same hash. An error, timeout, skip or abort leaves it
  // `unconfirmed`, which approve refuses just like an unstable one.
  if (toConfirm.size > 0) {
    const again = opts.stories.filter((s) => toConfirm.has(s.storyId));
    const unseen = new Set(toConfirm.keys());
    const seenWarnings = new Set<string>();
    const warnOnce = opts.onWarning
      ? (m: string) => {
          // The first pass already said this; don't repeat it per pool.
          if (!seenWarnings.has(m) && !firstPassWarnings.has(m)) {
            seenWarnings.add(m);
            opts.onWarning!(m);
          }
        }
      : undefined;
    let rechecked = 0;
    for await (const outcome of capturePool(again, {
      ...poolOptions(undefined),
      onProgress: (_d, _t, id) => opts.onRecheck?.(++rechecked, again.length, id),
      ...(warnOnce ? { onWarning: warnOnce } : {}),
    })) {
      const first = toConfirm.get(outcome.story.storyId);
      if (!first) continue;
      unseen.delete(first.storyId);
      if (!outcome.snapshot) {
        first.unstable = {
          hashes: [first.hash!],
          unconfirmed: outcome.error?.message ?? 'recheck capture produced no snapshot',
        };
        continue;
      }
      const second = hashImage(outcome.snapshot.image);
      if (second !== first.hash) first.unstable = { hashes: [first.hash!, second] };
      if (opts.signal?.aborted) break;
    }
    for (const id of unseen) {
      toConfirm.get(id)!.unstable = {
        hashes: [toConfirm.get(id)!.hash!],
        unconfirmed: 'run aborted before the recheck capture',
      };
    }
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
    hash: hashImage(snapshot.image),
    mismatchPixels: 0,
    mismatchPercent: 0,
    changedRegions: [],
    // The effective viewport, including any per-story override. Recording it
    // with the regions means nobody downstream has to re-enumerate stories to
    // find out what the coordinates are relative to.
    viewport: snapshot.viewport,
    // Never silent: a capture taken at the settle cap says so on every
    // status, a pass included, with what was still pending.
    ...(captureFlags(snapshot).length > 0 ? { flags: captureFlags(snapshot) } : {}),
    ...(snapshot.settle ? { settle: snapshot.settle } : {}),
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
    // The manifest's hash decided this failure; the image behind it is not on
    // this machine (cold CI cache, fresh clone). That is the normal state of a
    // project that never commits images, so explain with structure alone
    // rather than erroring: no pixel diff exists, and none is claimed.
    await opts.onArtifact?.({
      storyId: story.storyId,
      status,
      current: snapshot.image,
      structure: snapshot.structure,
    });
    const structural = await tryStructural(
      opts,
      story,
      snapshot,
      { changedRegions: [], dimensionMismatch: false },
      p,
      true,
    );
    return {
      ...base,
      baselineImage: 'unavailable',
      ...(structural ? { structural } : {}),
    };
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
  pixelsUnavailable = false,
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
      ...(pixelsUnavailable ? { pixelsUnavailable } : {}),
      pixels,
      escalate: { command: `jux handoff ${shellQuote(story.storyId)}` },
      ...(cause ? { cause } : {}),
      ...(snapshot.settle ? { settleFlag: settleFlag(snapshot.settle) } : {}),
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
