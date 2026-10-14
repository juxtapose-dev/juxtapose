---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/server': patch
---

Approving a baseline now requires two identical captures (#148). `jux run` captures each new or failing story a second time and records `unstable` in report.json when the hashes differ; passing stories cost nothing extra. `jux approve`, the MCP `approve` tool and the Storybook panel refuse an unstable story and name it, while approving the rest. Pass `--allow-unstable` (MCP: `allowUnstable`) to baseline one anyway.
