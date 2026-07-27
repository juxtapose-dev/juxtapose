# @juxtapose/adapter-ladle

Ladle platform adapter for juxtapose visual testing.

Part of [juxtapose](https://github.com/juxtapose-dev/juxtapose), visual
regression testing for component workbenches.

Enumerates from `meta.json` and waits on Ladle's own ready signal. Ladle's
`meta` is statically extracted and complete, so unlike Storybook there is no
live-parameter re-read to do — the whole adapter is 174 lines.

**You probably don't need to install this directly.** Use
[`@juxtapose/cli`](https://www.npmjs.com/package/@juxtapose/cli) for the
command line, or
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook)
to review diffs inside Storybook. This package is a building block those
depend on.

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC
