---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Cache design-reference comparison metadata alongside each saved run, keyed by the reference and current image hashes, geometry, and comparison policy. Include the largest changed region's bounds in the compact MCP run hint so agents can locate it without requesting the full reference ledger.
