# @juxtapose/server

Local HTTP API used by the juxtapose Storybook addon and custom review clients.

Part of [juxtapose](https://github.com/juxtapose-dev/juxtapose), visual
regression testing for component workbenches.

**You probably don't need to install this directly.** Use
[`@juxtapose/cli`](https://www.npmjs.com/package/@juxtapose/cli) for the
command line, or
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook)
to review diffs inside Storybook. This package is a building block those
depend on.

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC

### Run state

`GET /jux/api/bundle` and `GET /jux/api/progress` include an optional `run`
object (`ReviewRun`): `{ id, status, error? }`. Status is `running`, `completed`,
`failed`, or `cancelled`; `error` describes a failed attempt. It is absent before
the first attempt or on older servers. The existing `running` boolean remains
available. A failed attempt can coexist with the previous report: consumers
must check run state instead of treating the presence of a report as success.
Discovery failures caught by the run endpoint's preflight still return an HTTP
error directly. Accepted background failures are exposed through run state.
