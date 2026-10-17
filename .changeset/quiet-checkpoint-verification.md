---
'@juxtapose/cli': patch
---

Add opt-in MCP run checkpoint comparisons and target progress, so agents can
read baseline, target and saved-edit evidence in one call without recapturing.
Keep latest-run selection stable when derived analysis is added to an older run.
