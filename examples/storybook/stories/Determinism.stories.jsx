// These stories exist to exercise the capture pipeline, not to demo UI.
//
// Because juxtapose decides pass/fail with a byte-exact hash, anything
// nondeterministic in a render is a permanently failing build rather than a
// small mismatch percentage. Each story here targets one settle step. If the
// suite starts flaking, the story that flakes tells you which step regressed.

import { Spinner, FadeIn, AsyncContent, TextSpecimen } from 'example-components';

export default { title: 'Determinism' };

/**
 * Animation freezing.
 *
 * A spinner rotating at 0.7s/turn lands at an arbitrary angle at screenshot
 * time. juxtapose injects CSS zeroing animation and transition durations, so
 * this captures at a fixed frame. Remove that injection and this story fails
 * on essentially every run.
 */
export const InfiniteSpinner = { render: () => <Spinner /> };

/** Same freeze path, via a keyframe animation that runs once on mount. */
export const AnimatedEntrance = { render: () => <FadeIn text="Faded in deterministically." /> };

/**
 * Network quiescence.
 *
 * Renders a loading state, then real content after a fetch resolves. The
 * settle script patches window.fetch to count in-flight requests, so capture
 * waits for the request to settle instead of screenshotting the gap between
 * mount and response.
 */
export const AwaitsNetwork = { render: () => <AsyncContent delayMs={150} /> };

/**
 * Text rendering.
 *
 * Antialiased glyphs at several weights are the most sensitive input a pixel
 * differ receives. If webfont waiting or the device scale factor regresses,
 * this fails first.
 */
export const Typography = { render: () => <TextSpecimen /> };

/**
 * Opting out of the animation freeze, for stories about animation itself.
 *
 * Note what this costs: with animations live, the spinner is at an arbitrary
 * rotation when the shutter fires, so this story is inherently unstable under
 * a byte-exact hash. That is the honest tradeoff of `animations: 'play'`, and
 * the reason the freeze is on by default.
 *
 * `skip` is set here so the example suite stays green — a demo that is
 * permanently red teaches the wrong lesson. Remove it to watch the story flap.
 */
export const AnimationsRunning = {
  render: () => <Spinner size={40} />,
  parameters: { juxtapose: { animations: 'play', skip: true } },
};

/**
 * Excluded from capture entirely.
 *
 * Note the story still renders in Storybook — `skip` only affects juxtapose.
 */
export const NeverCaptured = {
  render: () => <p style={{ fontFamily: 'system-ui' }}>This story is never captured.</p>,
  parameters: { juxtapose: { skip: true } },
};

/**
 * A custom viewport.
 *
 * Overrides the project default for this story only. Region area percentages
 * in the agent handoff are computed against this viewport, not the default.
 */
export const NarrowViewport = {
  render: () => <TextSpecimen />,
  parameters: { juxtapose: { viewport: { width: 480, height: 400 } } },
};
