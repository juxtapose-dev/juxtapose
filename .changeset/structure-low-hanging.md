---
'@juxtapose/core': patch
---

Faster structure snapshots and structural diffs on large pages, with byte-identical output. Normalizing Primer's 110k-node TreeView story is about 3x faster. Four quadratic paths in the structural diff and flake analysis are now linear: inherited-style lookups, ordering removed elements, keyed alignment of large flat lists, and selector uniqueness counts.
