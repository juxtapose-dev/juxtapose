import { resolveComparison } from '../diff/comparison.js';
import { resolveRenderer } from '../capture/renderer.js';
// Orchestrate a run: enumerate → select → capture → judge → report.
//
// Hashing is the cheap exact fast path. Only mismatches decode baseline pixels,
// for explanation or an explicit visual-equivalence verdict. Exact passes never
// read or decode a baseline image.

import type { RecheckMode } from '../config/schema.js';
import { DEFAULT_RECHECK } from '../config/schema.js';
import { NOT_RECHECKED } from '../baseline/approve.js';
import type { Browser } from '../browser/browser.js';
import { resolveDevices } from '../browser/devices.js';
import { captureEnv, emulationChange, encoderChange } from '../capture/env.js';
import type { Platform } from '../platform.js';
import type {
  BaselineStore,
  DiffResult,
  DiffStatus,
  ProjectConfig,
  RunReport,
  Snapshot,
  StoryManifest,
  StructureSnapshot,
  Viewport,
} from '../types.js';
import { HttpCaptureError } from '../capture/capture.js';
import { capturePool } from '../capture/pool.js';
import {
  hashImage,
  resolveStatus,
  toDiffStatus,
  type AncestryCheck,
} from '../baseline/status.js';
import { decodeStructure } from '../capture/structure.js';
import { structuralDiffWithCoverage } from '../diff/structural.js';
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
import { networkCoverage } from '../flake/coverage.js';
import { groupFlakes } from '../flake/group.js';
import { analyzeFlake, type FlakeCapture } from '../flake/analyze.js';
import type { NetworkCoverage } from '../flake/classify.js';

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
  /** Optional local diagnostic for a verified differing recheck; never replaces the first capture. */
  onUnstableCapture?: (artifact: {
    storyId: string;
    image: Buffer;
    hash: string;
  }) => Promise<void>;
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
  /** Reads back the first capture of a story that `onArtifact` stored, for the
   *  flake analysis when its recheck differs. Captures are never kept in
   *  memory for this. Without it, an unstable story gets no `flake`. */
  readFirstCapture?: (
    storyId: string,
  ) => Promise<{ image: Buffer; structure?: StructureSnapshot } | undefined>;
  /** Per-call settle options (CLI flags, MCP arguments), layered over every
   *  story's own. The project's come from `config`. */
  settle?: SettleLayer;
  /** Per-call recheck mode (`--recheck`, the MCP argument), over the config's
   *  `recheck`; "changed" when neither is set. */
  recheck?: RecheckMode;
  /** Baseline creation overrides all renderer settings. */
  forceFreshRenderer?: boolean;
}

/** The mode a run uses: the call over the project config over the default. */
export function effectiveRecheck(
  call: RecheckMode | undefined,
  config: Pick<ProjectConfig, 'recheck'> | undefined,
): RecheckMode {
  return call ?? config?.recheck ?? DEFAULT_RECHECK;
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
  const recheck = effectiveRecheck(opts.recheck, opts.config);
  // Validate before opening the pool, including legacy/new conflicts.
  resolveRenderer(opts.config);
  resolveComparison(opts.config?.comparison);
  for (const story of opts.stories) resolveComparison(undefined, story.params.comparison);
  const results: DiffResult[] = [];
  const renderers = new Set<string>();
  const history = new Map<
    string,
    { result: DiffResult; renderer: ReturnType<typeof resolveRenderer> }
  >();
  const firstPassWarnings = new Set<string>();
  const toConfirm = new Map<string, DiffResult>();
  // What the recheck needs of a first capture besides its image and structure,
  // which are read back from where `onArtifact` put them. Small: no pixels.
  const firstNotes = new Map<string, Pick<FlakeCapture, 'settle' | 'flags'>>();

  const poolOptions = (onProgress: RunOptions['onProgress']) => ({
    ...poolSettings(opts, viewport),
    renderers,
    forceFreshRenderer: opts.forceFreshRenderer,
    onProgress,
    ...(opts.onWarning
      ? {
          onWarning: (m: string) => {
            firstPassWarnings.add(m);
            opts.onWarning!(m);
          },
        }
      : {}),
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
      if (outcome.error instanceof HttpCaptureError && outcome.error.image)
        await opts.onArtifact?.({
          storyId: outcome.story.storyId,
          status: 'fail',
          current: outcome.error.image,
        });
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
    const renderer =
      outcome.snapshot.renderer ??
      resolveRenderer(opts.config, outcome.story.params.renderer);
    if (result.status === 'fail' && result.hash && renderer.shared)
      history.set(result.storyId, { result, renderer });
    const covered =
      recheck !== 'off' &&
      (result.status === 'new' || (result.status === 'fail' && recheck === 'changed'));
    if ((result.status === 'new' || result.status === 'fail') && result.hash) {
      if (!covered) {
        // Not captured again: say so, so approve knows to confirm it and a
        // missing `unstable` or `flake` is never read as "stable".
        result.unrechecked = true;
        // Also an `unstable` verdict, so an approver older than `unrechecked`
        // (the review server, an older `jux approve`) refuses it instead of
        // baselining one capture. The current `jux approve` keys on
        // `unrechecked` and confirms the story instead.
        result.unstable = {
          hashes: [result.hash],
          unconfirmed: `${NOT_RECHECKED} (recheck ${recheck})`,
        };
        continue;
      }
      toConfirm.set(result.storyId, result);
      const { settle, flags } = flakeCapture(outcome.snapshot);
      firstNotes.set(result.storyId, {
        ...(settle ? { settle } : {}),
        ...(flags ? { flags } : {}),
      });
    }
  }

  // Select after the first pool closes: shuffled completion order must not
  // decide which stories receive the bounded retry budget.
  const retryLimit = Math.ceil(0.1 * results.filter((r) => r.status !== 'skip').length);
  const candidates = [...history.keys()].sort(compareCodeUnits);
  const retryIds = new Set(candidates.slice(0, retryLimit));
  for (const id of candidates) {
    const { result, renderer } = history.get(id)!;
    result.rendererRetry = {
      outcome: retryIds.has(id) ? 'unconfirmed' : 'cap',
      initialRenderer: renderer,
      initialHash: result.hash!,
      reason: retryIds.has(id)
        ? 'fresh retry did not complete'
        : 'fresh retry limit reached',
    };
  }
  if (retryIds.size) {
    const resultIndexes = new Map(
      results.map((result, index) => [result.storyId, index]),
    );
    // A baseline mismatch is the signal: do not guess from component names or
    // DOM features. Pulse once, then fall back to an isolated fresh renderer.
    // A proactive pulse already happened when clearResourceCache was enabled.
    const pulse = opts.stories.filter(
      (story) =>
        retryIds.has(story.storyId) &&
        !history.get(story.storyId)!.renderer.clearResourceCache,
    );
    for await (const outcome of capturePool(pulse, {
      ...poolOptions(undefined),
      forceResourceCache: true,
      warmSwitch: false,
    })) {
      const first = history.get(outcome.story.storyId)!.result;
      const evidence = first.rendererRetry!;
      if (!outcome.snapshot || outcome.error) {
        evidence.cachePulseError =
          outcome.error?.message ?? 'cache pulse produced no snapshot';
        continue;
      }
      evidence.cachePulseHash = hashImage(outcome.snapshot.image);
      first.durationMs = (first.durationMs ?? 0) + (outcome.snapshot.durationMs ?? 0);
      // Keep the reviewed artifact intact unless recovery actually passes.
      if (evidence.cachePulseHash !== manifest.baselines[first.storyId]?.hash) continue;
      const pulsed = await judge(outcome.snapshot, outcome.story, manifest, opts, p);
      if (pulsed.status !== 'pass') continue;
      pulsed.rendererRetry = {
        ...evidence,
        outcome: 'resolved',
        resolvedBy: 'cache-pulse',
        reason: undefined,
      };
      pulsed.durationMs = first.durationMs;
      results[resultIndexes.get(first.storyId)!] = pulsed;
      retryIds.delete(first.storyId);
      toConfirm.delete(first.storyId);
      firstNotes.delete(first.storyId);
    }
    const again = opts.stories.filter((story) => retryIds.has(story.storyId));
    for await (const outcome of capturePool(again, {
      ...poolOptions(undefined),
      forceFreshRenderer: true,
      warmSwitch: false,
    })) {
      const first = history.get(outcome.story.storyId)!.result;
      const evidence = first.rendererRetry!;
      if (!outcome.snapshot || outcome.snapshot.rendererReused) {
        evidence.reason =
          outcome.error?.message ??
          (outcome.snapshot?.rendererReused
            ? 'fresh retry reused a renderer'
            : 'fresh retry produced no snapshot');
        continue;
      }
      const fresh = await judge(
        outcome.snapshot,
        outcome.story,
        manifest,
        opts,
        p,
        false,
      );
      const resolved = fresh.status === 'pass';
      fresh.rendererRetry = {
        ...evidence,
        reason: undefined,
        resolvedBy: resolved ? 'fresh' : undefined,
        outcome: resolved ? 'resolved' : 'mismatch',
        initialRenderer: evidence.initialRenderer,
        initialHash: evidence.initialHash,
        freshHash: fresh.hash,
      };
      fresh.durationMs = (first.durationMs ?? 0) + (fresh.durationMs ?? 0);
      results[resultIndexes.get(first.storyId)!] = fresh;
      toConfirm.delete(first.storyId);
      firstNotes.delete(first.storyId);
      if (!resolved) {
        if (recheck === 'changed') {
          toConfirm.set(fresh.storyId, fresh);
          const { settle, flags } = flakeCapture(outcome.snapshot);
          firstNotes.set(fresh.storyId, { settle, flags });
        } else {
          fresh.unrechecked = true;
          fresh.unstable = {
            hashes: [fresh.hash!],
            unconfirmed: `${NOT_RECHECKED} (recheck ${recheck})`,
          };
        }
      }
    }
    // A failed or aborted fresh retry cannot become approvable because a
    // separate stability capture happened to reproduce the shared image.
    for (const id of retryIds) {
      const first = history.get(id)!.result;
      if (results[resultIndexes.get(id)!] === first) {
        toConfirm.delete(id);
        first.unstable = {
          hashes: [first.hash!],
          unconfirmed: first.rendererRetry!.reason,
        };
      }
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
      forceFreshRenderer: true,
      warmSwitch: false,
      onProgress: (_d, _t, id) => opts.onRecheck?.(++rechecked, again.length, id),
      ...(warnOnce ? { onWarning: warnOnce } : {}),
    })) {
      const first = toConfirm.get(outcome.story.storyId);
      if (!first) continue;
      unseen.delete(first.storyId);
      if (!outcome.snapshot || outcome.snapshot.rendererReused) {
        first.unstable = {
          hashes: [first.hash!],
          unconfirmed: outcome.error?.message ?? 'recheck capture produced no snapshot',
        };
        continue;
      }
      const second = hashImage(outcome.snapshot.image);
      if (second !== first.hash) {
        first.unstable = { hashes: [first.hash!, second] };
        if (opts.onUnstableCapture) {
          try {
            await opts.onUnstableCapture({
              storyId: first.storyId,
              image: outcome.snapshot.image,
              hash: second,
            });
          } catch (error) {
            throw new Error(`Unable to save unstable confirmation for ${first.storyId}`, {
              cause: error,
            });
          }
        }
        const flake = opts.readFirstCapture
          ? await tryFlake(
              first.storyId,
              () => opts.readFirstCapture!(first.storyId),
              firstNotes.get(first.storyId) ?? {},
              flakeCapture(outcome.snapshot),
              coverageOf(outcome.story, opts),
              opts.config?.freshRenderer !== false,
            )
          : undefined;
        if (flake) first.flake = flake;
      }
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
  const flakeGroups = groupFlakes(
    results.flatMap((r) => (r.flake ? [{ storyId: r.storyId, flake: r.flake }] : [])),
  );

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
    recheck,
    summary,
    ...(groups.length > 0 ? { groups } : {}),
    ...(flakeGroups.length > 0 ? { flakeGroups } : {}),
    durationMs: Date.now() - started,
    startedAt: startedAt.toISOString(),
  };
}

/** How a run's pool captures, from the config and the call. Shared with the
 *  confirming capture `jux approve` takes, so the two cannot disagree. */
export function poolSettings(
  opts: Pick<
    RunOptions,
    'browser' | 'platform' | 'baseUrl' | 'config' | 'settle' | 'signal'
  >,
  viewport: Viewport = opts.config?.viewport ?? DEFAULT_VIEWPORT,
) {
  return {
    browser: opts.browser,
    platform: opts.platform,
    baseUrl: opts.baseUrl,
    concurrency: opts.config?.concurrency,
    warmSwitch: opts.config?.warmSwitch,
    renderer: opts.config?.renderer,
    ...(opts.config?.freshRenderer !== undefined
      ? { freshRenderer: opts.config.freshRenderer }
      : {}),
    ...(opts.config?.storyTimeout !== undefined
      ? { storyTimeoutMs: opts.config.storyTimeout }
      : {}),
    viewport,
    devices: resolveDevices(opts.config?.devices),
    ...(opts.config?.device !== undefined ? { defaultDevice: opts.config.device } : {}),
    ...(opts.config?.orientation !== undefined
      ? { defaultOrientation: opts.config.orientation }
      : {}),
    settleLayers: {
      project: {
        ...(opts.config?.settle ? { settle: opts.config.settle } : {}),
        ...(opts.config?.network ? { network: opts.config.network } : {}),
        ...(opts.config?.freeze ? { freeze: opts.config.freeze } : {}),
        ...(opts.config?.waitForSelector !== undefined
          ? { waitForSelector: opts.config.waitForSelector }
          : {}),
        ...(opts.config?.delay !== undefined ? { delay: opts.config.delay } : {}),
      },
      ...(opts.settle ? { call: opts.settle } : {}),
    },
    signal: opts.signal,
  };
}

/** Decide one story's fate. Cheap path first. */
async function judge(
  snapshot: Snapshot,
  story: StoryManifest,
  manifest: Awaited<ReturnType<BaselineStore['readManifest']>>,
  opts: RunOptions,
  p: Phases,
  allowEquivalence = true,
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
    ...(snapshot.layoutViewport ? { layoutViewport: snapshot.layoutViewport } : {}),
    ...(snapshot.device !== undefined ? { device: snapshot.device } : {}),
    ...(snapshot.emulation !== undefined ? { emulation: snapshot.emulation } : {}),
    // Never silent: a capture taken at the settle cap says so on every
    // status, a pass included, with what was still pending.
    ...(captureFlags(snapshot).length > 0 ? { flags: captureFlags(snapshot) } : {}),
    ...(snapshot.settle ? { settle: snapshot.settle } : {}),
    durationMs: snapshot.durationMs,
    ...(snapshot.timings ? { timings: snapshot.timings } : {}),
    ...(snapshot.structureTimings ? { structureTimings: snapshot.structureTimings } : {}),
  };
  const fromEncoder =
    status === 'fail' ? encoderChange(manifest.baselines[story.storyId]) : undefined;
  if (fromEncoder !== undefined) base.baselineEncoder = fromEncoder;
  const fromDevice =
    status === 'fail'
      ? emulationChange(manifest.baselines[story.storyId], snapshot.emulation)
      : undefined;
  if (fromDevice !== undefined) base.baselineEmulation = fromDevice;

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
  if (!baseline && !opts.store.lookup) {
    // A store that cannot say why keeps the original wording: its image is
    // supposed to be there, so its absence is an error.
    await opts.onArtifact?.({
      storyId: story.storyId,
      status,
      current: snapshot.image,
      structure: snapshot.structure,
    });
    return { ...base, error: 'baseline missing from store' };
  }
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
      ...structural,
    };
  }

  const comparison = resolveComparison(
    opts.config?.comparison,
    snapshot.comparison ?? story.params.comparison,
  );
  const equivalentMode = allowEquivalence && comparison?.mode === 'pixelmatch';
  const comparisonThreshold = comparison?.threshold ?? 0.05;
  // Never accept pixels from an image that is not the approved hash. Cache
  // corruption or a stale store pointer must not turn a mismatch into a pass.
  if (equivalentMode && hashImage(baseline) !== manifest.baselines[story.storyId]?.hash) {
    await opts.onArtifact?.({
      storyId: story.storyId,
      status: 'fail',
      current: snapshot.image,
      structure: snapshot.structure,
    });
    return { ...base, error: 'baseline image does not match its approved hash' };
  }

  // Counted as well as timed: under a byte-exact hash the number of diffs is
  // how broken the run was, and it is the figure that explains a slow one.
  p.count('diff');
  const diff = await p.time('diff', () =>
    diffImages(baseline, snapshot.image, {
      threshold: equivalentMode
        ? comparisonThreshold
        : resolveThreshold(story.params, opts.config),
      minDiffPercent: equivalentMode
        ? 0
        : resolveMinDiffPercent(story.params, opts.config),
    }),
  );

  if (
    equivalentMode &&
    !diff.dimensionMismatch &&
    diff.mismatchPixels === 0 &&
    (!opts.ancestry ||
      opts.ancestry.isAncestor(manifest.baselines[story.storyId]!.commit))
  ) {
    await opts.onArtifact?.({
      storyId: story.storyId,
      status: 'pass',
      current: snapshot.image,
      structure: snapshot.structure,
    });
    delete base.baselineEncoder;
    delete base.baselineEmulation;
    return {
      ...base,
      status: 'pass',
      comparison: {
        method: 'pixelmatch',
        version: '6.0.0',
        threshold: comparisonThreshold,
        includeAA: false,
        baselineHash: manifest.baselines[story.storyId]!.hash,
        rawMismatchPixels: diff.rawMismatchPixels ?? 0,
      },
    };
  }

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
    ...structural,
  };
}

/** The parts of a capture the flake analysis reads. */
function flakeCapture(snapshot: Snapshot): FlakeCapture {
  const flags = captureFlags(snapshot);
  return {
    image: snapshot.image,
    ...(snapshot.structure ? { structure: snapshot.structure } : {}),
    ...(snapshot.settle ? { settle: snapshot.settle } : {}),
    ...(flags.length > 0 ? { flags } : {}),
  };
}

/** Explaining a flake never fails the story: it is already `unstable`, and a
 *  bug in the analysis must not turn a recheck into an error. */
async function tryFlake(
  storyId: string,
  readFirst: () => Promise<Pick<FlakeCapture, 'image' | 'structure'> | undefined>,
  firstNotes: Pick<FlakeCapture, 'settle' | 'flags'>,
  second: FlakeCapture,
  covered: NetworkCoverage,
  freshRenderer: boolean,
): Promise<DiffResult['flake']> {
  try {
    const stored = await readFirst();
    if (!stored) return undefined;
    return await analyzeFlake({
      storyId,
      first: { ...stored, ...firstNotes },
      second,
      covered,
      freshRenderer,
    });
  } catch {
    return undefined;
  }
}

/** The story's network config already answers some third-party requests. */
function coverageOf(story: StoryManifest, opts: RunOptions): NetworkCoverage {
  return networkCoverage(
    opts.config?.network,
    story.params.network,
    opts.settle?.network,
  );
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
): Promise<Pick<DiffResult, 'structural' | 'controlGeometry'> | undefined> {
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
    const baseline = await readBaselineStructure(opts.store, story.storyId);
    const { verdict: structural, controlGeometry } = structuralDiffWithCoverage({
      baseline,
      current: snapshot.structure,
      imagesIdentical: false,
      includeControlGeometry: true,
      ...(pixelsUnavailable ? { pixelsUnavailable } : {}),
      pixels,
      escalate: { command: `jux handoff ${shellQuote(story.storyId)}` },
      ...(cause ? { cause } : {}),
      ...(snapshot.settle ? { settleFlag: settleFlag(snapshot.settle) } : {}),
    });
    return { structural, ...(controlGeometry ? { controlGeometry } : {}) };
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
