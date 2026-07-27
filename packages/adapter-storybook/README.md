# @juxtapose/adapter-storybook

Storybook platform adapter for juxtapose visual testing.

Part of [juxtapose](https://github.com/juxtapose-dev/juxtapose), visual
regression testing for component workbenches.

Enumerates from `index.json`, drives stories over Storybook's preview channel,
and re-reads `parameters.juxtapose` from the live preview. That last step is
not optional: Storybook drops custom parameters from its static index, so
`skip` and per-story viewports are invisible without it. Renderer-agnostic —
React and Vue both run in CI.

**You probably don't need to install this directly.** Use
[`@juxtapose/cli`](https://www.npmjs.com/package/@juxtapose/cli) for the
command line, or
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook)
to review diffs inside Storybook. This package is a building block those
depend on.

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC
