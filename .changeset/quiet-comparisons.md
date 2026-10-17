---
'@juxtapose/cli': minor
'@juxtapose/core': patch
---

Let MCP agents request a saved previous/current image diff only when they need
to inspect an edit. Keep target comparison as the default, return focused
region crops on demand, and cache repeated saved-run comparisons in the MCP
session.
