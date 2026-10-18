---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Add on-demand `report({story, element, properties})` to inspect one element's saved current rectangle and captured computed styles without recapturing. Require unique exact-field matches, abstain on truncated/ambiguous snapshots, bound output and preserve identities. Reuse/coalesce decoded sidecars and report parsing, and invalidate changed files. Export the pure inspector and types from core; document the focused request in MCP guidance.
