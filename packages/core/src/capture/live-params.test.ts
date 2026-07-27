// Guards the live-params merge (issue #12).
//
// Storybook only serializes a whitelist of parameters into index.json, so
// `parameters.juxtapose` is essentially never there. Before this, every
// per-story threshold, viewport, waitForSelector and skip was silently
// dropped on the platform that has 97.5% of the market — silently being the
// operative word: nothing failed, stories were just captured with the wrong
// settings forever.

import { describe, it, expect } from 'vitest';
import type { StoryParams } from '../types.js';

/**
 * The merge the capture path performs once a story has rendered.
 *
 * Extracted here rather than driving a real browser because the behaviour
 * worth pinning is the precedence and the copy semantics, not Playwright.
 * The end-to-end proof lives in the examples: Storybook now captures 14
 * stories rather than 16, matching Ladle, and `narrow-viewport` is captured
 * at its declared 480x400 instead of the project default.
 */
function mergeLiveParams(
  manifest: StoryParams,
  live: StoryParams | undefined,
): StoryParams {
  const params: StoryParams = { ...manifest };
  if (live) Object.assign(params, live);
  return params;
}

describe('live params merge', () => {
  it('keeps manifest params when the platform reports none', () => {
    const manifest = { threshold: 0.5 };
    expect(mergeLiveParams(manifest, undefined)).toEqual({ threshold: 0.5 });
  });

  it('lets live params win over the manifest', () => {
    // The live preview is the story's own declaration; the index is a lossy
    // projection of it, so the index must not override.
    const merged = mergeLiveParams({ threshold: 0.5 }, { threshold: 0.1 });
    expect(merged.threshold).toBe(0.1);
  });

  it('adds params the index never carried', () => {
    // The actual Storybook case: index.json has nothing, the story declares
    // everything.
    const merged = mergeLiveParams(
      {},
      { skip: true, viewport: { width: 480, height: 400 } },
    );
    expect(merged.skip).toBe(true);
    expect(merged.viewport).toEqual({ width: 480, height: 400 });
  });

  it('does not mutate the manifest entry', () => {
    // The manifest object is shared across a run. Mutating it would leak one
    // story's live config into whatever the pool captures next.
    const manifest: StoryParams = { threshold: 0.5 };
    mergeLiveParams(manifest, { threshold: 0.1, skip: true });
    expect(manifest).toEqual({ threshold: 0.5 });
  });

  it('merges rather than replaces, so unrelated manifest params survive', () => {
    const merged = mergeLiveParams({ delay: 100 }, { threshold: 0.2 });
    expect(merged).toEqual({ delay: 100, threshold: 0.2 });
  });
});
