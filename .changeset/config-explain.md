---
'@juxtapose/cli': minor
'@juxtapose/core': minor
---

`jux config --explain <storyId>` prints the capture settings one story or variant key would use and which layer each came from (#179): the project config, the story's `parameters.juxtapose`, the `stories` globs that matched, the variant and its `extends` chain, live params, or a CLI flag. `--json` prints `juxtapose.explain/v1`. The `explain` MCP tool returns the same. It shows `network.external` per resource type and the effective `network.rules` in evaluation order, each with its layer. Nothing is captured; discovery runs as it does for `jux run`. An unknown id exits 2 with the closest ids. `@juxtapose/core` exports `ProvenanceLog`, `explainCapture`, `findCaptures` and `liveReader`, and `expandVariants`, `mergeLiveParams` and `prepareCaptures` take an optional trace that records sources and changes no result.
