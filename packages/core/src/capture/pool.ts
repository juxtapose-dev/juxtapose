// Worker pool: fan stories across N parallel pages, yielding results as they
// complete. Used by both the CLI and the dev-server review API, which is why
// it takes a Browser rather than owning one.

import {
  BrowserDiedError,
  type Browser,
  type BrowserContext,
} from '../browser/browser.js';
import { SendTimeoutError, TargetClosedError } from '../browser/cdp.js';
import { PageCrashedError, TimeoutError, type Page } from '../browser/page.js';
import type { Platform } from '../platform.js';
import type { Snapshot, StoryManifest, Viewport } from '../types.js';
import { captureStory, type CaptureDeps } from './capture.js';
import type { SettleLayer } from './settle-options.js';

/**
 * Default parallelism.
 *
 * Empirically 8 on a 10-core machine (~80% utilization). This is NOT a
 * "higher is better" knob: at 16+ the render-ready timeout starts firing from
 * CPU contention rather than real story failures, and 32 measured ~50% SLOWER
 * than 16 on the same suite. Scale to core count, not to infinity.
 */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Per-story budget, ms. Bounds the whole capture of one story (navigation,
 * settle, structure, screenshot, encode).
 *
 * Why it exists: every CDP call carries its own 30 s cap, and a page whose main
 * thread is busy (Primer's ~110k-element treeview story) stalls each in turn:
 * the stacked caps measured 127-160 s for one story (issue #154). The default
 * leaves room for a slow legitimate story (settle's own cap defaults to
 * 1.5 s) while keeping a wedged one from tripling a run.
 *
 * It is a floor, not a ceiling over settle: a story's effective budget is
 * max(this, settle cap + delay + SETTLE_ALLOWANCE_MS), because settle must
 * never throw on timeout (a slow story is a reviewable diff, not an error).
 */
export const DEFAULT_STORY_TIMEOUT_MS = 60_000;

/** Time beyond settle's cap and delay for navigation, the platform's render
 *  signal, the paint barrier, structure capture and the screenshot. */
export const SETTLE_ALLOWANCE_MS = 15_000;

/** The story used up its whole budget; the page it ran on is discarded. */
export class StoryTimeoutError extends Error {
  constructor(storyId: string, budgetMs: number, phase: string) {
    super(
      `jux: story '${storyId}' exceeded its ${budgetMs} ms budget while in '${phase}'; ` +
        `its page was discarded. A page whose main thread is busy (a very large DOM, a ` +
        `runaway script) stalls every browser call; raise storyTimeout if the story is ` +
        `genuinely slow.`,
    );
    this.name = 'StoryTimeoutError';
  }
}

export interface PoolOptions {
  /** Per-story budget, ms; see DEFAULT_STORY_TIMEOUT_MS. */
  storyTimeoutMs?: number;
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
  /** A new renderer per cold capture; default true. See CaptureDeps. */
  freshRenderer?: boolean;
  renderer?: CaptureDeps['renderer'];
  forceFreshRenderer?: boolean;
  renderers?: Set<string>;
  /** Non-fatal notices from capture, e.g. an ignored live variant override. */
  onWarning?: (message: string) => void;
  /** Settle options around each story's own; see CaptureDeps. */
  settleLayers?: { project?: SettleLayer; call?: SettleLayer };
}

export interface CaptureOutcome {
  story: StoryManifest;
  snapshot?: Snapshot;
  error?: Error;
  /** Wall time spent on the story, errored or not. */
  durationMs: number;
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
  const budgetMs = opts.storyTimeoutMs ?? DEFAULT_STORY_TIMEOUT_MS;
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

  // Every renderer process that hosted a capture in this run, shared across
  // the workers: a story that lands in another page's used renderer is as
  // order-dependent as one that stays in its own (#153).
  const renderers = opts.renderers ?? new Set<string>();
  let warnedReuse = false;
  const noteReuse = (snapshot: Snapshot) => {
    if (!snapshot.rendererReused || warnedReuse) return;
    warnedReuse = true;
    opts.onWarning?.(
      `jux: ${snapshot.storyId} ran in a renderer process an earlier story used, so its pixels can depend on that story (#153). Chrome reached its renderer-process limit: lower --concurrency, or check the browser's --renderer-process-limit. Affected results are flagged renderer-reused.`,
    );
  };

  const workers = Array.from({ length: workerCount }, async () => {
    let session: { context: BrowserContext; page: Page } | null = await open();
    const baseDeps: CaptureDeps = {
      platform: opts.platform,
      baseUrl: opts.baseUrl,
      warmSwitch: opts.warmSwitch,
      renderer: opts.renderer,
      forceFreshRenderer: opts.forceFreshRenderer,
      ...(opts.freshRenderer !== undefined ? { freshRenderer: opts.freshRenderer } : {}),
      ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
      ...(opts.settleLayers ? { settleLayers: opts.settleLayers } : {}),
      renderers,
    };

    try {
      for (;;) {
        if (opts.signal?.aborted) break;
        const i = cursor++;
        if (i >= work.length) break;
        const story = work[i]!; // i < work.length, checked above

        if (died || !session) {
          push({ story, error: died ?? new BrowserDiedError(), durationMs: 0 });
          opts.onProgress?.(++done, work.length, story.storyId);
          continue;
        }

        const started = Date.now();
        try {
          const snapshot = await budgetedCapture(story.storyId, budgetMs, (hooks) =>
            captureStory(session!.page, story, { ...baseDeps, ...hooks }, opts.viewport),
          );
          if (opts.forceFreshRenderer && snapshot?.rendererReused)
            throw new Error(
              'fresh capture reused a renderer; lower concurrency and run again',
            );
          // null means the story declared `skip` in params only visible once
          // it had rendered. Report it as skipped, not as a failure.
          const durationMs = Date.now() - started;
          if (snapshot) noteReuse(snapshot);
          push(
            snapshot
              ? { story, snapshot, durationMs }
              : { story, skipped: true, durationMs },
          );
        } catch (err) {
          // One bad story must never kill a run of 700. Report it as a failure
          // for this story and keep the worker going.
          push({
            story,
            error: err instanceof Error ? err : new Error(String(err)),
            durationMs: Date.now() - started,
          });
          // A crashed renderer or a closed target is permanent for that page:
          // left alone, every later story on this worker failed instantly
          // (concurrency 2, one crash: 6 of 8 stories failed). Replace the
          // worker's context and page; if the browser itself is gone, stop.
          if (!opts.browser.isConnected()) {
            died ??= new BrowserDiedError(err);
          } else if (
            err instanceof PageCrashedError ||
            err instanceof TargetClosedError ||
            // A busy main thread usually trips the 30 s navigation or call
            // cap, below the story budget; the page stays busy.
            err instanceof TimeoutError ||
            err instanceof SendTimeoutError ||
            err instanceof StoryTimeoutError
          ) {
            // For a timeout the abandoned capture is still running against
            // this page; closing the context rejects its pending calls, which
            // withBudget has already detached.
            await closeBounded(session.context);
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

/** How long a worker waits for a wedged context to close before moving on. */
const CLOSE_GRACE_MS = 5_000;

/** Close a context that may be wedged: a busy renderer may never answer, so
 *  the wait is bounded. */
export async function closeBounded(context: BrowserContext): Promise<void> {
  let grace: NodeJS.Timeout | undefined;
  await Promise.race([
    context.close().catch(() => {}),
    new Promise<void>((r) => (grace = setTimeout(r, CLOSE_GRACE_MS))),
  ]);
  clearTimeout(grace);
}

/** The hooks captureStory takes that the budget listens to. */
export interface BudgetHooks {
  onPhase: (phase: string) => void;
  onSettleBudget: (ms: number) => void;
}

/**
 * Run one capture under the per-story budget. The effective budget is
 * max(budgetMs, elapsed + settle cap + delay + waitForSelector + allowance),
 * so it never pre-empts settle; expiry rejects with a StoryTimeoutError naming
 * the phase the capture was stuck in. Shared by the pool and `snapPages`.
 */
export function budgetedCapture<T>(
  storyId: string,
  budgetMs: number,
  run: (hooks: BudgetHooks) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let phase = 'starting';
  let effectiveMs = budgetMs;
  return withBudget(
    run({
      onPhase: (p) => (phase = p),
      onSettleBudget: (ms) => {
        // Measured from now, not from the start: a slow navigation
        // must not eat the allowance settle was promised.
        effectiveMs = Math.max(budgetMs, Date.now() - started + ms + SETTLE_ALLOWANCE_MS);
      },
    }),
    () => effectiveMs,
    () => new StoryTimeoutError(storyId, effectiveMs, phase),
  );
}

/** Reject with `expired()` once `work` has run `ms()` (re-read as it grows,
 *  see onSettleBudget). `work` is detached, not cancelled: the caller discards
 *  the page it runs on. */
function withBudget<T>(
  work: Promise<T>,
  ms: () => number,
  expired: () => Error,
): Promise<T> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, reject) => {
    const arm = () => {
      const left = started + ms() - Date.now();
      if (left <= 0) reject(expired());
      else timer = setTimeout(arm, left);
    };
    arm();
  });
  // The loser's rejection must not surface as an unhandled one.
  work.catch(() => {});
  return Promise.race([work, budget]).finally(() => clearTimeout(timer));
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
