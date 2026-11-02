---
'@juxtapose/cli': patch
'@juxtapose/server': patch
---

Print capture warnings during `jux init` and local review-server runs so renderer reuse and other capture diagnostics are visible. Warnings go to stderr, preserving JSON output.
