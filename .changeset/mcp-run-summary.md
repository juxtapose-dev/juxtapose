---
'@juxtapose/cli': minor
---

Keep MCP `run` output bounded for large workbenches, with a read-only `report` tool for a saved run or one full story result. MCP sessions cache parsed saved reports; `run({report: 'full'})` retains the complete response.
