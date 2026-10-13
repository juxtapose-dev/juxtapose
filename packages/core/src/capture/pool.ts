// Worker pool: fan stories across N parallel pages, yielding results as they
// complete. Used by both the CLI and the dev-server review API, which is why
// it takes a Browser rather than owning one.

import {
  BrowserDiedError,
  type Browser,
  type BrowserContext,
} from '../browser/browser.js';
import { TargetClosedError } from '../browser/cdp.js';
import { PageCrashedError, type Page } from '../browser/page.js';
import type { Platform } from '../platform.js';
import type { Snapshot, StoryManifest, Viewport } from '../types.js';
import { captureStory, type CaptureDeps } from './capture.js';

/**
 * Default parallelism.
 *
 * Empirically 8 on a 10-core machine (~80% utilization). This is NOT a
 * "higher is better" knob: at 16+ the render-ready timeout starts firing from
 * CPU contention rather than real story failures, and 32 measured ~50% SLOWER
 * than 16 on the same suite. Scale to core count, not to infinity.
 */
export const DEFAULT_CONCURRENCY = 8;

export interface PoolOptions {
  browser: Browser;
  platform: Platform;
  baseUrl: string;
  concurrency?: number;
  viewport: Viewport;
  /** Called as each story finishes, for progress reporting. */
  onProgress?: (done: number, total: number, storyId: string) => void;
  /** Cooperative cancellation, checked at story boundaries. */
  signal?: AbortSignal;
  /** Reuse warm pages and switch stories in place. Faster, but does not
   *  currently reproduce cold-load pixels exactly — see CaptureDeps. */
  warmSwitch?: boolean;
  /** Non-fatal notices from capture, e.g. an ignored live variant override. */
  onWarning?: (message: string) => void;
}

export interface CaptureOutcome {
  story: StoryManifest;
  snapshot?: Snapshot;
  error?: Error;
  /** The story asked to be skipped via params the index didn't carry. */
  skipped?: boolean;
}

/**
 * Capture stories across N parallel pages, yielding results as they complete.
 *
 * Each worker owns its own BrowserContext. Sharing one context across workers
 * was measured at ~0% faster and leaks state between concurrently-rendering
 * stories — most visibly a service worker registered by one story racing
 * another's navigation. Isolation wins on a tie.
 */
export async function* capturePool(
  stories: StoryManifest[],
  opts: PoolOptions,
): AsyncGenerator<CaptureOutcome> {
  const queue = stories.filter((s) => s.params.skip !== true);
  if (queue.length === 0) return;

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const workerCount = Math.min(concurrency, queue.length);

  // Shuffle so stories from one slow component don't cluster at the tail and
  // serialize the final stretch on a single worker. Skipped at concurrency 1,
  // where ordering is deterministic and there's nothing to interleave.
  const work = workerCount > 1 ? shuffle(queue) : queue;

  let cursor = 0;
  let done = 0;
  const buffer: CaptureOutcome[] = [];
  let notify: (() => void) | null = null;

  const push = (out: CaptureOutcome) => {
    buffer.push(out);
    notify?.();
    notify = null;
  };

  // Set once the browser itself is gone: every story not yet taken fails with
  // it, without touching a page, so a dead browser reads as one failure.
  let died: BrowserDiedError | null = null;

  const open = async (): Promise<{ context: BrowserContext; page: Page }> => {
    // No Retina: it quadruples buffer size for no diff signal. deviceScaleFactor
    // is pinned to 1 by the driver and `--force-device-scale-factor=1`.
    const context = await opts.browser.newContext({ viewport: opts.viewport });
    try {
      return { context, page: await context.newPage() };
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  };

  const workers = Array.from({ length: workerCount }, async () => {
    let session: { context: BrowserContext; page: Page } | null = await open();
    const deps: CaptureDeps = {
      platform: opts.platform,
      baseUrl: opts.baseUrl,
      warmSwitch: opts.warmSwitch,
      ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
    };

    try {
      for (;;) {
        if (opts.signal?.aborted) break;
        const i = cursor++;
        if (i >= work.length) break;
        const story = work[i]!; // i < work.length, checked above

        if (died || !session) {
          push({ story, error: died ?? new BrowserDiedError() });
          opts.onProgress?.(++done, work.length, story.storyId);
          continue;
        }

        try {
          const snapshot = await captureStory(session.page, story, deps, opts.viewport);
          // null means the story declared `skip` in params only visible once
          // it had rendered. Report it as skipped, not as a failure.
          push(snapshot ? { story, snapshot } : { story, skipped: true });
        } catch (err) {
          // One bad story must never kill a run of 700. Report it as a failure
          // for this story and keep the worker going.
          push({ story, error: err instanceof Error ? err : new Error(String(err)) });
          // A crashed renderer or a closed target is permanent for that page:
          // left alone, every later story on this worker failed instantly
          // (concurrency 2, one crash: 6 of 8 stories failed). Replace the
          // worker's context and page; if the browser itself is gone, stop.
          if (!opts.browser.isConnected()) {
            died ??= new BrowserDiedError(err);
          } else if (
            err instanceof PageCrashedError ||
            err instanceof TargetClosedError
          ) {
            await session.context.close().catch(() => {});
            session = await open().catch((e: unknown) => {
              died ??= new BrowserDiedError(e);
              return null;
            });
          }
        }

        opts.onProgress?.(++done, work.length, story.storyId);
      }
    } finally {
      await session?.context.close().catch(() => {});
    }
  });

  const all = Promise.all(workers);
  let finished = false;
  void all.then(
    () => {
      finished = true;
      notify?.();
      notify = null;
    },
    () => {
      finished = true;
      notify?.();
      notify = null;
    },
  );

  while (!finished || buffer.length > 0) {
    if (buffer.length === 0) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      continue;
    }
    yield buffer.shift()!;
  }

  await all;
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // j <= i < out.length: both indices are in range.
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
