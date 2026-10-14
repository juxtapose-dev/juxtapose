---
'@juxtapose/cli': minor
'@juxtapose/core': minor
---

`report.json` results now carry `hash`, the sha256 of the story's current capture (the hash `baselines/` compares), and `jux diff --runs <runA> <runB>` compares two runs by it (#129). It takes run ids or run directories, prints identical and different counts and the differing story ids (`--json`: `juxtapose.run-diff/v1`), and exits 0 when identical, 1 otherwise. `hash` is optional, so older reports still parse and are compared by hashing their images.
