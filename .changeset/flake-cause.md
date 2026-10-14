---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

An unstable story now says why it flaked and what to change (#190, step 1). `report.json` gains `flake: { cause, confidence, evidence, fix }` on a story whose two run captures differed, and `jux diff --runs` explains each story that differs the same way. `cause` is one of `settle-timeout`, `external-image`, `embed`, `async-element`, `clock`, `random-content`, `render-drift` or `unknown`, from the first check that matches. `fix` is an exact patch for `juxtapose.config.json`, scoped to the story (`stories["card--basic"].network.external.images = "placeholder"`), or `null` when no config change helps. `jux run`, `jux diff --runs` and `jux handoff` print one line for it, and the MCP `run` result carries the object. The structure snapshot records the origin and path of third-party images, backgrounds and iframes (not part of `structureHash`, and read from the same browser response, so captures are unchanged). `@juxtapose/core` exports `analyzeFlake`, `describeFlake`, `formatFix` and the `Flake` types.
