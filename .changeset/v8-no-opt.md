---
'@juxtapose/core': patch
---

Capture Chrome uses V8's `--no-opt` flag while retaining Maglev. Merge caller-supplied V8 flags into one switch so Chrome does not silently discard earlier flags.
