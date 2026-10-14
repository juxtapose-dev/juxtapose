---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Per-story overrides in the project config (#128). `stories: { "<id glob>": { skip, mask, delay, waitForSelector, captureTimeout, settle, network, threshold, minDiffPercent } }` stabilizes or skips volatile stories in a Storybook you don't own (a deployed `origin`, a third-party `buildDir`), where `parameters.juxtapose` can't be edited. An override beats the story's own parameters (including live ones) and loses only to the command line; when several keys match, the more specific wins, masks union and settle merges. A key matching a story also covers its variants, and `<id>__<variant>` targets one. Bad entries fail up front naming the glob and option, in run, init, snap, MCP and the review server. Stories skipped by config are reported (`skippedBy` in the report, the run summary, the PR comment and `jux handoff`).
