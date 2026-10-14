---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/server': minor
'@juxtapose/storybook': minor
---

Approving a baseline now requires two identical captures (#148). `jux run` captures each new or failing story a second time and records `unstable` in report.json when the hashes differ, or `unstable.unconfirmed` when the second capture fails, so an unverified story is never approved. Passing and stale stories are not rechecked (stale already matches a recorded hash), so a green run costs nothing extra; a first run and `jux init` take about 2x as long. `jux approve`, `jux init`, the MCP `approve` tool and the Storybook panel refuse an unstable story and name it, while approving the rest; the review server answers 409. Pass `--allow-unstable` (MCP: `allowUnstable`) to baseline one anyway. `jux run`, `check`, `handoff`, the PR comment and the HTML report mark unstable stories, and the panel's "approve all" now shows refusals instead of swallowing them.
