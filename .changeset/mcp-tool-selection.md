---
'@juxtapose/cli': patch
---

Add optional `jux mcp --tools <comma-separated names>` to limit discovery and invocation to selected tools. All tools remain available by default. Restricted initialization avoids routing to hidden tools, while capture behavior and approval restrictions remain unchanged.
