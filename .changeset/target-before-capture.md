---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Allow MCP clients to read a configured design PNG with `reference({ name, detail: "target" })` before the first capture. Returns image content and target metadata without opening a browser or changing comparison policy.
