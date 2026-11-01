# Packages

For most projects, install the CLI and optionally the Storybook addon:

| package                | what it is                                           |
| ---------------------- | ---------------------------------------------------- |
| `@juxtapose/cli`       | the `jux` command — capture, approve, check, handoff |
| `@juxtapose/storybook` | Storybook addon: review diffs in place, watch mode   |

The CLI captures Ladle stories directly. Ladle does not provide an addon panel.

These packages are installed as dependencies. Use them directly when building
an adapter or a review UI:

| package                        | what it is                                                 |
| ------------------------------ | ---------------------------------------------------------- |
| `@juxtapose/core`              | capture, diff, baselines, analysis — no platform knowledge |
| `@juxtapose/server`            | the local HTTP API used by the addon                       |
| `@juxtapose/adapter-storybook` | lists and renders Storybook stories for capture            |
| `@juxtapose/adapter-ladle`     | lists and renders Ladle stories for capture                |

`@juxtapose/adapter-storybook` runs in Node and drives the browser for capture.
`@juxtapose/storybook` adds the review UI inside Storybook and installs the
adapter as a dependency.
