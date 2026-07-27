# @juxtapose/server

Local review API for juxtapose — the contract every review UI is a skin over.

Part of [juxtapose](https://github.com/juxtapose-dev/juxtapose), visual
regression testing for component workbenches.

Serves run reports, images and approvals over HTTP, so a review UI never has
to know how baselines are stored. `@juxtapose/storybook` mounts it inside
Storybook's own dev server — no second process, no port to configure.

**You probably don't need to install this directly.** Use
[`@juxtapose/cli`](https://www.npmjs.com/package/@juxtapose/cli) for the
command line, or
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook)
to review diffs inside Storybook. This package is a building block those
depend on.

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC
