---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Include selected approved/current control dimensions in compact MCP run summaries when ancestor deduplication hides the measurement and no direct fact is available. Group identical measurements across captures, preserve their scope, and cap the block at three items and 768 bytes. Full story reports retain bounded measured detail. Reuse the existing structural matching pass and loaded snapshots; leave visual acceptance unchanged.
