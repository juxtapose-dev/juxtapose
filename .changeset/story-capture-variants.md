---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/adapter-storybook': minor
'@juxtapose/storybook': minor
'@juxtapose/server': minor
---

Per-story capture variants. Declare `variants` on a story's juxtapose params, on a URL entry, or project-wide in `juxtapose.config.json`, for example `{ "variants": { "dark": { "colorScheme": "dark" }, "mobile": { "viewport": { "width": 375, "height": 812 } } } }`. Each variant is captured, judged and approved on its own under the key `<story id>__<variant>`. A story can opt out of a project variant with `false`, and `extends` builds one variant on another. Existing baselines are default captures and keep passing.

`jux run --story <id>` now works: a story id captures the story with all its variants, a capture key just that one, and an unknown id exits 2. The MCP `run` tool's `stories` argument now applies the same selection. `jux approve --story` and the MCP `approve` tool accept a story id to approve every variant in the run. Story ids in the commands that the PR comment and handoff print are now shell-quoted.

`jux run --since` now captures every story when `juxtapose.config.json` or `.juxtaposerc.json` changes, because a project-wide variant there changes every story's captures. The exported `Page` interface gains an optional `setColorScheme`. A `Page` implemented outside core doesn't need it: core falls back to raw `Emulation.setEmulatedMedia`.

Storybook story parameters are now read before capture. The adapter loads the preview once and reads every story's `parameters.juxtapose`, so story-level variants, `skip` and `viewport` apply from the first frame. Before this, they were only known after the story rendered. Platforms can provide the same through the new optional `Platform.discoverParams`. If discovery fails, jux warns and falls back to the index. A story skipped in its parameters no longer appears as a `skip` row in Storybook reports, which matches Ladle.

CLI output and the PR comment show a variant as `story · variant` and count captures across stories. The HTML report nests variants under their story, and a handoff on a variant says what the variant sets. In the Storybook addon, a story's sidebar dot shows the worst status across its variants. The panel switches between the default capture and each variant, with "Approve all variants", and watch mode recaptures a story's variants. The review server expands a story id to its captures.

Discovered parameters are cached in `.juxtapose/runs/.cache`, keyed by the built preview's `index.json` and `iframe.html`, so an unchanged static build skips the preview load. The cache is never used against a dev server. `jux run --since` now also captures every story when the project's own `package.json` changes, including a project in a subdirectory of its repository. `jux approve --story <story id>` only approves the captures that need it (changed, new or stale) when the story has variants in the run, and that rule covers the story's default capture too.
