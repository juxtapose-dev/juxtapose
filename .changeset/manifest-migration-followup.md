---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Follow-up to the no-committed-images change, shipping in the same release. The manifest stays `"version": 1` (the inline `structure` per story is an additive field, so a previous release still reads the same hashes instead of an empty manifest), and `jux run` never writes the manifest: only `jux approve` does. Legacy `.structure.json.gz` sidecars move into the manifest with the new `jux doctor --fix`, which folds them in where they match the approved baseline and captures and approves nothing; doctor no longer suggests `jux approve --all` for this. `jux doctor` and `jux handoff` report a manifest with merge conflict markers (exit 2 for handoff), and `jux approve` exits 2 once instead of failing every story. A symlinked `.juxtapose` or `.juxtapose/cache` is refused before any directory is created at its target. Printed git commands that use pathspec magic work when `GIT_LITERAL_PATHSPECS=1` is exported.
