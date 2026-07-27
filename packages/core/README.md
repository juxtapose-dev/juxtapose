# @juxtapose/core

Platform-agnostic capture, diff, baseline and analysis core for juxtapose.

Part of [juxtapose](https://github.com/juxtapose-dev/juxtapose), visual
regression testing for component workbenches.

`core` never imports an adapter. Platform differences enter through five
required methods — `detect`, `enumerate`, `showStory`, `previewUrl`, `settle` —
and both shipped adapters were written against that interface without changing
it, which is the evidence it is a real seam rather than Storybook's API in
disguise.

**You probably don't need to install this directly.** Use
[`@juxtapose/cli`](https://www.npmjs.com/package/@juxtapose/cli) for the
command line, or
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook)
to review diffs inside Storybook. This package is a building block those
depend on.

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC
