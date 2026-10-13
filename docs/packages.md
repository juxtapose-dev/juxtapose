# Packages

Two of these are the ones you install:

| package                | what it is                                           |
| ---------------------- | ---------------------------------------------------- |
| `@juxtapose/cli`       | the `jux` command — capture, approve, check, handoff |
| `@juxtapose/storybook` | Storybook addon: review diffs in place, watch mode   |

Ladle needs no second package — the CLI covers it, and Ladle has no addon slot
to put a panel in.

The rest arrive as dependencies. You would reach for one directly only to build
an adapter or a UI of your own:

| package                        | what it is                                                 |
| ------------------------------ | ---------------------------------------------------------- |
| `@juxtapose/core`              | capture, diff, baselines, analysis — no platform knowledge |
| `@juxtapose/server`            | the local review API the addon is a skin over              |
| `@juxtapose/adapter-storybook` | teaches the CLI to drive Storybook                         |
| `@juxtapose/adapter-ladle`     | teaches the CLI to drive Ladle                             |

The two Storybook packages are not alternatives. `adapter-storybook` is how the
CLI captures stories — it runs in Node, drives a browser, and you never import
it. `@juxtapose/storybook` is the addon that renders the review UI inside
Storybook itself. Installing the addon pulls the adapter in.
