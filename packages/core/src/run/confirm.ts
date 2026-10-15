// Approval always captures fresh, even if the run already rechecked. A
// reused renderer can reproduce history-dependent pixels twice; only a fresh
// match establishes that the reviewed bytes are suitable for a baseline.

import { hashImage } from '../baseline/status.js';
import { capturePool } from '../capture/pool.js';
import { captureEnv, describeEnvChange, sameEnv } from '../capture/env.js';
import type { CaptureEnv, StoryManifest } from '../types.js';
import { poolSettings, type RunOptions } from './run.js';

export interface Confirmation {
  storyId: string;
  /** Absent when the second capture matched the run's: two identical
   *  captures, so the story is stable. Same shape as `DiffResult.unstable`. */
  unstable?: { hashes: string[]; unconfirmed?: string };
}

export interface ConfirmOptions extends Pick<
  RunOptions,
  'browser' | 'platform' | 'baseUrl' | 'config' | 'signal'
> {
  /** The captures to take again. */
  stories: StoryManifest[];
  /** What the run's capture of each hashed to, by capture key. */
  hashes: ReadonlyMap<string, string>;
  /** What captured the run's images. A different browser, OS or encoder
   *  changes bytes without a change in the page, so a hash compared across
   *  them proves nothing: every story is then `unconfirmed`. Unknown (an old
   *  report) is compared as it is. */
  env?: CaptureEnv;
  /** Called as each capture finishes. */
  onProgress?: (done: number, total: number, storyId: string) => void;
}

/** One confirmation per story, in no particular order. A capture that errors,
 *  times out or is aborted is `unconfirmed`, never assumed stable. */
export async function confirmCaptures(opts: ConfirmOptions): Promise<Confirmation[]> {
  const out = new Map<string, Confirmation>();
  const now = captureEnv(opts.browser);
  if (opts.env && !sameEnv(opts.env, now)) {
    const why = `this machine's capture environment differs from the run's (${describeEnvChange(opts.env, now)}), so the hashes cannot be compared; run again here`;
    return opts.stories.flatMap((s) => {
      const first = opts.hashes.get(s.storyId);
      return first === undefined
        ? []
        : [{ storyId: s.storyId, unstable: { hashes: [first], unconfirmed: why } }];
    });
  }
  const pool = capturePool(opts.stories, {
    ...poolSettings(opts),
    forceFreshRenderer: true,
    warmSwitch: false,
    onProgress: opts.onProgress,
  });
  for await (const outcome of pool) {
    const id = outcome.story.storyId;
    const first = opts.hashes.get(id);
    if (first === undefined) continue;
    if (!outcome.snapshot || outcome.snapshot.rendererReused) {
      out.set(id, {
        storyId: id,
        unstable: {
          hashes: [first],
          unconfirmed:
            outcome.error?.message ?? 'confirming capture produced no snapshot',
        },
      });
      continue;
    }
    const second = hashImage(outcome.snapshot.image);
    out.set(id, {
      storyId: id,
      ...(second === first ? {} : { unstable: { hashes: [first, second] } }),
    });
    if (opts.signal?.aborted) break;
  }
  for (const s of opts.stories) {
    const first = opts.hashes.get(s.storyId);
    if (first !== undefined && !out.has(s.storyId))
      out.set(s.storyId, {
        storyId: s.storyId,
        unstable: { hashes: [first], unconfirmed: 'the confirming capture did not run' },
      });
  }
  return [...out.values()];
}
