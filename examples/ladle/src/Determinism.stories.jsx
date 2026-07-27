// The Ladle counterpart of the Storybook determinism stories.
//
// Same components, same coverage — the difference is how per-story config is
// declared. Storybook uses `parameters.juxtapose`; Ladle has no parameters
// concept, so juxtapose reads `meta.juxtapose` instead. Ladle extracts `meta`
// by static analysis at build time, so it must be a literal: no computed
// values, no spreads, no imports.

import { Spinner, FadeIn, AsyncContent, TextSpecimen } from 'example-components';

/** Animation freezing — a spinner would otherwise land on a random frame. */
export const InfiniteSpinner = () => <Spinner />;

/** Same freeze path, via a keyframe animation that runs once on mount. */
export const AnimatedEntrance = () => <FadeIn text="Faded in deterministically." />;

/** Network quiescence — capture must wait for the fetch, not catch the gap. */
export const AwaitsNetwork = () => <AsyncContent />;

/** Antialiased text, the most sensitive input a pixel differ receives. */
export const Typography = () => <TextSpecimen />;

/**
 * Opts out of the animation freeze, for stories about animation itself.
 *
 * Note what this costs: with animations live, the spinner is at an arbitrary
 * rotation when the shutter fires, so this story is inherently unstable under
 * a byte-exact hash. That is the honest tradeoff of `animations: 'play'`, and
 * the reason the freeze is on by default.
 *
 * `skip` is set here so the example suite stays green — a demo that is
 * permanently red teaches the wrong lesson. Remove it to watch the story flap.
 */
export const AnimationsRunning = () => <Spinner size={40} />;
AnimationsRunning.meta = { juxtapose: { animations: 'play', skip: true } };

/** Excluded from capture. Still renders in Ladle — `skip` only affects juxtapose. */
export const NeverCaptured = () => (
  <p style={{ fontFamily: 'system-ui' }}>This story is never captured.</p>
);
NeverCaptured.meta = { juxtapose: { skip: true } };

/** A per-story viewport override. */
export const NarrowViewport = () => <TextSpecimen />;
NarrowViewport.meta = { juxtapose: { viewport: { width: 480, height: 400 } } };
