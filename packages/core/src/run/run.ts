// Orchestrate a run: enumerate → select → capture → judge → report.
//
// The ordering reflects the cost model. Hashing is cheap and decides pass/fail,
// so it runs for every story. Decoding and diffing are expensive and explain
// nothing about a passing story, so they run only for stories that already
// failed. On a green run this function never decodes a single image.

import type { Browser } from 'playwright';
import type { Platform } from '../platform.js';
import type {
  BaselineStore,
  DiffResult,
  DiffStatus,
  ProjectConfig,
  RunReport,
  Snapshot,
  StoryManifest,
  Viewport,
} from '../types.js';
import { capturePool } from '../capture/pool.js';
import { resolveStatus, toDiffStatus, type AncestryCheck } from '../baseline/status.js';
import { diffImages, resolveThreshold, resolveMinDiffPercent } from '../diff/diff.js';

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
  signal?: AbortSignal;
}

export interface RunArtifact {
  storyId: string;
  status: DiffStatus;
  current: Buffer;
  diff?: Buffer;
}

export async function runCapture(opts: RunOptions): Promise<RunReport> {
  const startedAt = new Date();
  const started = Date.now();
  const viewport = opts.config?.viewport ?? DEFAULT_VIEWPORT;
  const manifest = await opts.store.readManifest();
  const results: DiffResult[] = [];

  const pool = capturePool(opts.stories, {
    browser: opts.browser,
    platform: opts.platform,
    baseUrl: opts.baseUrl,
    concurrency: opts.config?.concurrency,
    warmSwitch: opts.config?.warmSwitch,
    viewport,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });

  for await (const outcome of pool) {
    if (outcome.skipped) {
      results.push({
        storyId: outcome.story.storyId,
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
        status: 'fail',
        mismatchPixels: 0,
        mismatchPercent: 0,
        changedRegions: [],
        error: outcome.error?.message ?? 'capture produced no snapshot',
        durationMs: 0,
      });
      continue;
    }

    results.push(await judge(outcome.snapshot, outcome.story, manifest, opts));
  }

  const summary = tally(results);

  return {
    runId: opts.runId,
    branch: opts.branch,
    commitSha: opts.commitSha,
    capturedCount: opts.stories.length,
    totalCount: opts.totalCount,
    results: results.sort((a, b) => a.storyId.localeCompare(b.storyId)),
    summary,
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
    status,
    mismatchPixels: 0,
    mismatchPercent: 0,
    changedRegions: [],
    // The effective viewport, including any per-story override. Recording it
    // with the regions means nobody downstream has to re-enumerate stories to
    // find out what the coordinates are relative to.
    viewport: snapshot.viewport,
    durationMs: snapshot.durationMs,
  };

  // pass / new / stale need no pixel work: there is either nothing to explain
  // or nothing to compare against.
  if (status !== 'fail') {
    await opts.onArtifact?.({ storyId: story.storyId, status, current: snapshot.image });
    return base;
  }

  const baseline = await opts.store.get(story.storyId);
  if (!baseline) {
    // The manifest claimed a baseline the store can't produce.
    await opts.onArtifact?.({ storyId: story.storyId, status, current: snapshot.image });
    return { ...base, error: 'baseline missing from store' };
  }

  const diff = await diffImages(baseline, snapshot.image, {
    threshold: resolveThreshold(story.params, opts.config),
    minDiffPercent: resolveMinDiffPercent(story.params, opts.config),
  });

  await opts.onArtifact?.({
    storyId: story.storyId,
    status,
    current: snapshot.image,
    diff: diff.diffImage,
  });

  return {
    ...base,
    mismatchPixels: diff.mismatchPixels,
    mismatchPercent: diff.mismatchPercent,
    changedRegions: diff.changedRegions,
    error: diff.dimensionMismatch ? 'viewport size changed since baseline' : undefined,
  };
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
